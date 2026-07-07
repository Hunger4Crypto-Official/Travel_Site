import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountStore } from '../../src/accounts/accountStore.js';
import { BillingService } from '../../src/billing/billingService.js';

function fakeGateway(over = {}) {
  const calls = { createCustomer: 0, createSubscription: 0, cancelSubscription: 0 };
  return {
    calls,
    name: 'stripe',
    live: over.live ?? false,
    createCustomer: over.createCustomer || (async ({ userId }) => { calls.createCustomer++; return { customerId: `cus_${userId}` }; }),
    createSubscription: over.createSubscription || (async ({ tierId }) => { calls.createSubscription++; return { subscriptionId: `sub_${tierId}`, status: 'active', currentPeriodEnd: 999, tierId }; }),
    cancelSubscription: over.cancelSubscription || (async ({ subscriptionId }) => { calls.cancelSubscription++; return { subscriptionId, status: 'canceled' }; }),
    verifyWebhookSignature: over.verifyWebhookSignature || (() => true),
    parseWebhookEvent: over.parseWebhookEvent || ((raw) => { try { return JSON.parse(raw); } catch { const e = new Error('Invalid webhook payload'); e.statusCode = 400; throw e; } })
  };
}

function makeBilling(over = {}, webhookSecret = null, requireLiveGateway = false) {
  let n = 0;
  const store = new AccountStore({ idFactory: () => `u${++n}` });
  const user = store.create({ email: 'm@example.com', passwordHash: 'h' });
  const gateway = fakeGateway(over);
  const service = new BillingService({ store, gateway, priceIds: { silver: 'price_s', gold: 'price_g' }, webhookSecret, requireLiveGateway });
  return { store, user, gateway, service };
}

test('subscribe rejects the free tier and an unknown tier', async () => {
  const { service, user } = makeBilling();
  await assert.rejects(() => service.subscribe(user, 'free'), (e) => e.statusCode === 400);
  await assert.rejects(() => service.subscribe(user, 'platinum'), (e) => e.statusCode === 400);
});

test('subscribe to a paid tier creates a customer + subscription and upgrades the member', async () => {
  const { service, store, user, gateway } = makeBilling();
  const result = await service.subscribe(user, 'gold');
  assert.equal(result.member.tier, 'gold');
  assert.equal(result.member.memberRates, true);
  assert.equal(result.member.subscriptionStatus, 'active');
  assert.equal(result.subscription.tier, 'gold');
  assert.equal(result.subscription.subscriptionId, 'sub_gold');
  const stored = store.get(user.id);
  assert.equal(stored.tier, 'gold');
  assert.equal(stored.stripeCustomerId, `cus_${user.id}`);
  assert.equal(gateway.calls.createCustomer, 1);

  // A second subscribe reuses the existing customer.
  const fresh = store.get(user.id);
  await service.subscribe(fresh, 'silver');
  assert.equal(gateway.calls.createCustomer, 1, 'the customer is created once');
  assert.equal(store.get(user.id).tier, 'silver');
});

test('a live-gateway requirement blocks sandbox tier grants but allows a live gateway', async () => {
  // requireLiveGateway + sandbox gateway -> refuse (partially configured prod).
  const sandbox = makeBilling({ live: false }, null, true);
  await assert.rejects(() => sandbox.service.subscribe(sandbox.user, 'gold'), (e) => e.statusCode === 503);
  assert.equal(sandbox.store.get(sandbox.user.id).tier, 'free');

  // requireLiveGateway + live gateway -> proceeds.
  const live = makeBilling({ live: true }, null, true);
  const result = await live.service.subscribe(live.user, 'gold');
  assert.equal(result.member.tier, 'gold');
});

test('cancel requires an active subscription, then downgrades to free', async () => {
  const { service, store, user } = makeBilling();
  await assert.rejects(() => service.cancel(user), (e) => e.statusCode === 400);

  await service.subscribe(user, 'gold');
  const subscribed = store.get(user.id);
  const result = await service.cancel(subscribed);
  assert.equal(result.member.tier, 'free');
  assert.equal(result.subscription.status, 'canceled');
  const stored = store.get(user.id);
  assert.equal(stored.tier, 'free');
  assert.equal(stored.subscriptionId, null);
});

test('status reports the current subscription and gateway mode', async () => {
  const { service, store, user } = makeBilling();
  await service.subscribe(user, 'silver');
  const status = service.status(store.get(user.id));
  assert.equal(status.tier, 'silver');
  assert.equal(status.subscriptionStatus, 'active');
  assert.equal(status.subscriptionTier, 'silver');
  assert.equal(status.periodEnd, 999);
  assert.equal(status.live, false);
});

test('status defaults optional fields for a member without a subscription', () => {
  const { service, user } = makeBilling();
  const status = service.status(user);
  assert.equal(status.subscriptionStatus, null);
  assert.equal(status.subscriptionTier, null);
  assert.equal(status.periodEnd, null);
});

test('handleWebhook fails closed without a secret, and verifies with one', async () => {
  // No secret configured: refuse to apply anything (503), never mutate a member.
  const noSecret = makeBilling();
  await noSecret.service.subscribe(noSecret.user, 'gold');
  assert.throws(() => noSecret.service.handleWebhook(JSON.stringify({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_gold' } } }), 'sig'), (e) => e.statusCode === 503);
  assert.equal(noSecret.store.get(noSecret.user.id).tier, 'gold', 'the unauthenticated webhook did not downgrade');

  // Secret + invalid signature: 401.
  const bad = makeBilling({ verifyWebhookSignature: () => false }, 'whsec_x');
  assert.throws(() => bad.service.handleWebhook('{}', 'bad-sig'), (e) => e.statusCode === 401);

  // Secret + valid signature: the event is applied.
  const ok = makeBilling({ verifyWebhookSignature: () => true }, 'whsec_x');
  await ok.service.subscribe(ok.user, 'gold');
  const applied = ok.service.handleWebhook(JSON.stringify({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_gold' } } }), 'good-sig');
  assert.equal(applied.action, 'downgraded');
  assert.equal(ok.store.get(ok.user.id).tier, 'free');
});

test('handleWebhook surfaces a malformed payload as 400 (once past signature checks)', () => {
  const { service } = makeBilling({ verifyWebhookSignature: () => true }, 'whsec_x');
  assert.throws(() => service.handleWebhook('not json', 'sig'), (e) => e.statusCode === 400);
});

test('applyEvent covers every branch', async () => {
  const { service, store, user } = makeBilling();
  await service.subscribe(user, 'gold');

  assert.deepEqual(service.applyEvent({ type: 'customer.subscription.deleted', data: {} }).reason, 'no subscription id');
  assert.deepEqual(service.applyEvent({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_nomatch' } } }).reason, 'no matching member');

  const updated = service.applyEvent({ type: 'customer.subscription.updated', data: { object: { id: 'sub_gold', status: 'past_due' } } });
  assert.equal(updated.action, 'status-synced');
  assert.equal(store.get(user.id).subscriptionStatus, 'past_due');

  // updated without a status keeps the current one (?? fallback).
  service.applyEvent({ type: 'customer.subscription.updated', data: { object: { id: 'sub_gold' } } });
  assert.equal(store.get(user.id).subscriptionStatus, 'past_due');

  assert.equal(service.applyEvent({ type: 'invoice.paid', data: { object: { id: 'sub_gold' } } }).reason, 'ignored event type');

  const deleted = service.applyEvent({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_gold' } } });
  assert.equal(deleted.action, 'downgraded');
  assert.equal(store.get(user.id).tier, 'free');
});
