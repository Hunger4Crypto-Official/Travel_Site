import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountStore } from '../../src/accounts/accountStore.js';
import { LoyaltyLedger } from '../../src/loyalty/loyaltyLedger.js';
import { LoyaltyService } from '../../src/loyalty/loyaltyService.js';

function make() {
  let u = 0;
  let t = 0;
  const accountStore = new AccountStore({ idFactory: () => `u${++u}` });
  const ledger = new LoyaltyLedger({ idFactory: () => `t${++t}` });
  return { accountStore, ledger, service: new LoyaltyService({ ledger, accountStore }) };
}

test('earnForBooking awards points to a member and records a transaction', () => {
  const { accountStore, ledger, service } = make();
  const user = accountStore.create({ email: 'a@b.com', passwordHash: 'h' });
  const earned = service.earnForBooking(`user:${user.id}`, { id: 'o1', price: { total: 200 } });
  assert.equal(earned.points, 200); // free tier, 1x
  assert.equal(earned.balance, 200);
  assert.equal(accountStore.get(user.id).loyaltyPoints, 200);
  assert.equal(ledger.list(user.id).length, 1);
  assert.equal(ledger.list(user.id)[0].type, 'earn');
});

test('earnForBooking applies the tier multiplier and falls back to order.total', () => {
  const { accountStore, service } = make();
  const user = accountStore.create({ email: 'g@b.com', passwordHash: 'h' });
  accountStore.update(user.id, { tier: 'gold' }); // 3x
  const earned = service.earnForBooking(`user:${user.id}`, { id: 'o2', total: 150 }); // no price.total
  assert.equal(earned.points, 450);
});

test('earnForBooking returns null for non-members, vanished users, and zero-value trips', () => {
  const { accountStore, service } = make();
  const user = accountStore.create({ email: 'z@b.com', passwordHash: 'h' });
  assert.equal(service.earnForBooking('anonymous', { id: 'o', price: { total: 100 } }), null);
  assert.equal(service.earnForBooking('api-key:abc', { id: 'o', price: { total: 100 } }), null);
  assert.equal(service.earnForBooking('user:ghost', { id: 'o', price: { total: 100 } }), null);
  assert.equal(service.earnForBooking(`user:${user.id}`, { id: 'o', price: { total: 0 } }), null);
});

test('earnForBooking covers defensive fallbacks', () => {
  const { accountStore, service } = make();
  // A non-string owner is not a member.
  assert.equal(service.earnForBooking(null, { id: 'o', price: { total: 100 } }), null);

  // An unknown tier falls back to a 1x multiplier.
  const u1 = accountStore.create({ email: 'u1@b.com', passwordHash: 'h' });
  accountStore.update(u1.id, { tier: 'bogus' });
  assert.equal(service.earnForBooking(`user:${u1.id}`, { id: 'o', price: { total: 50 } }).points, 50);

  // A member record missing loyaltyPoints still earns (?? 0 fallback).
  const u2 = accountStore.create({ email: 'u2@b.com', passwordHash: 'h' });
  delete accountStore.get(u2.id).loyaltyPoints;
  assert.equal(service.earnForBooking(`user:${u2.id}`, { id: 'o', price: { total: 70 } }).balance, 70);

  // Orders with no priced total (or a null order) earn nothing.
  assert.equal(service.earnForBooking(`user:${u2.id}`, { id: 'o' }), null);
  assert.equal(service.earnForBooking(`user:${u2.id}`, null), null);
});

test('reverseForBooking claws back the awarded points, flooring at zero', () => {
  const { accountStore, ledger, service } = make();
  const user = accountStore.create({ email: 'c@b.com', passwordHash: 'h' });
  service.earnForBooking(`user:${user.id}`, { id: 'o1', price: { total: 200 } }); // +200
  const reversed = service.reverseForBooking(`user:${user.id}`, { id: 'o1', loyaltyEarned: 200 });
  assert.equal(reversed.balance, 0);
  assert.equal(accountStore.get(user.id).loyaltyPoints, 0);
  assert.ok(ledger.list(user.id).some((t) => t.type === 'reverse'));

  // Floors at zero even if the balance was already spent down.
  service.earnForBooking(`user:${user.id}`, { id: 'o2', price: { total: 50 } }); // +50
  const floored = service.reverseForBooking(`user:${user.id}`, { id: 'o2', loyaltyEarned: 999 });
  assert.equal(floored.balance, 0);

  // A record with no loyaltyPoints field still reverses (?? 0 fallback).
  const fresh = accountStore.create({ email: 'nf@b.com', passwordHash: 'h' });
  delete accountStore.get(fresh.id).loyaltyPoints;
  assert.equal(service.reverseForBooking(`user:${fresh.id}`, { id: 'o3', loyaltyEarned: 5 }).balance, 0);
});

test('reverseForBooking is a no-op for non-members, missing users, and zero earn', () => {
  const { accountStore, service } = make();
  const user = accountStore.create({ email: 'd@b.com', passwordHash: 'h' });
  assert.equal(service.reverseForBooking('anonymous', { id: 'o', loyaltyEarned: 10 }), null);
  assert.equal(service.reverseForBooking('user:ghost', { id: 'o', loyaltyEarned: 10 }), null);
  assert.equal(service.reverseForBooking(`user:${user.id}`, { id: 'o' }), null); // no loyaltyEarned
});

test('redeem validates the amount and deducts from the balance', () => {
  const { accountStore, ledger, service } = make();
  const user = accountStore.create({ email: 'r@b.com', passwordHash: 'h' });
  accountStore.update(user.id, { loyaltyPoints: 500 });
  const current = accountStore.get(user.id);

  assert.throws(() => service.redeem(current, 10.5), (e) => e.statusCode === 400);
  assert.throws(() => service.redeem(current, 0), (e) => e.statusCode === 400);
  assert.throws(() => service.redeem(current, 600), (e) => e.statusCode === 400);

  const result = service.redeem(current, 300);
  assert.equal(result.balance, 200);
  assert.equal(result.creditUsd, 3);
  assert.equal(accountStore.get(user.id).loyaltyPoints, 200);
  assert.equal(ledger.list(user.id)[0].type, 'redeem');
});

test('redeem tolerates a member with no prior points', () => {
  const { accountStore, service } = make();
  const user = accountStore.create({ email: 'n@b.com', passwordHash: 'h' });
  assert.throws(() => service.redeem(accountStore.get(user.id), 50), (e) => e.statusCode === 400);
});

test('redeem and summary default a missing balance to zero', () => {
  const { service } = make();
  const bare = { id: 'x', tier: 'free' }; // no loyaltyPoints field
  assert.throws(() => service.redeem(bare, 10), (e) => e.statusCode === 400);
  assert.equal(service.summary(bare).balance, 0);
});

test('summary reports balance, multiplier, and history', () => {
  const { accountStore, service } = make();
  const user = accountStore.create({ email: 's@b.com', passwordHash: 'h' });
  service.earnForBooking(`user:${user.id}`, { id: 'o', price: { total: 120 } });
  const summary = service.summary(accountStore.get(user.id));
  assert.equal(summary.balance, 120);
  assert.equal(summary.multiplier, 1);
  assert.equal(summary.pointsPerUsd, 100);
  assert.equal(summary.transactions.length, 1);
});
