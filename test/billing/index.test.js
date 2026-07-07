import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountStore } from '../../src/accounts/accountStore.js';
import { createBillingService } from '../../src/billing/index.js';

const baseConfig = {
  billingEnabled: true, stripeSecretKey: null, stripeWebhookSecret: null,
  stripePriceSilver: null, stripePriceGold: null, providerTimeoutMs: 8000
};

test('createBillingService returns null when disabled or without an account store', () => {
  assert.equal(createBillingService({ ...baseConfig, billingEnabled: false }, new AccountStore({})), null);
  assert.equal(createBillingService(baseConfig, null), null);
  const svc = createBillingService(baseConfig, new AccountStore({}));
  assert.equal(svc.gateway.live, false);
});

test('a live gateway routes calls through the injected fetch with a timeout', async () => {
  const captured = [];
  const fakeFetch = async (url, opts) => {
    captured.push({ url, opts });
    if (url.endsWith('/customers')) return { id: 'cus_1' };
    if (url.endsWith('/subscriptions')) return { id: 'sub_1', status: 'active', current_period_end: 1000 };
    return {};
  };
  const store = new AccountStore({});
  const user = store.create({ email: 'a@b.com', passwordHash: 'h' });
  const svc = createBillingService(
    { ...baseConfig, stripeSecretKey: 'sk_test', stripePriceSilver: 'price_s', stripePriceGold: 'price_g' },
    store,
    { fetchJson: fakeFetch }
  );
  assert.equal(svc.gateway.live, true);
  const result = await svc.subscribe(user, 'gold');
  assert.equal(result.member.tier, 'gold');
  assert.ok(captured.some((c) => c.url.endsWith('/customers')));
  assert.ok(captured.some((c) => c.url.endsWith('/subscriptions')));
  assert.ok(captured.every((c) => c.opts.timeoutMs === 8000));
});
