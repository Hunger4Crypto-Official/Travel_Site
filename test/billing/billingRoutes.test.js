import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { brand } from '../../src/config/brand.js';
import { handleRequest } from '../../src/routes/router.js';
import { AccountStore } from '../../src/accounts/accountStore.js';
import { AccountService } from '../../src/accounts/accountService.js';
import { createSessionManager } from '../../src/accounts/sessions.js';
import { createBillingService } from '../../src/billing/index.js';
import { createHmac } from 'node:crypto';
import { KeyedRateLimiter } from '../../src/utils/rateLimit.js';

const logger = { info() {}, warn() {}, error() {}, debug() {} };
const engine = {
  search: async () => ({}), flexibleSearch: async () => ({}), readiness: () => ({ ok: true }),
  metricsSnapshot: () => ({}), priceHistorySnapshot: () => ({}), createAlert: () => ({}), listAlerts: () => ({}), deleteAlert: () => ({})
};
const billingConfig = { billingEnabled: true, stripeSecretKey: null, stripeWebhookSecret: null, stripePriceSilver: null, stripePriceGold: null, providerTimeoutMs: 8000 };

function makeStack({ billingEnabled = true, webhookSecret = null, writeLimiter = null } = {}) {
  const store = new AccountStore({});
  const accountService = new AccountService({ store, sessions: createSessionManager({ secret: 'billing-test-secret' }) });
  const billingService = createBillingService({ ...billingConfig, billingEnabled, stripeWebhookSecret: webhookSecret }, billingEnabled ? store : null);
  return { store, accountService, billingService, writeLimiter };
}

// Build a Stripe-style signature header for a raw payload.
function stripeSig(secret, payload) {
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

async function withServer(stack, fn) {
  const config = { allowedOrigins: ['*'], requireApiKey: false, apiKeys: [], sessionTtlMs: 604800000, cookieSecure: false };
  const server = createServer((req, res) => handleRequest(req, res, { engine, brand, logger, config, accountService: stack.accountService, billingService: stack.billingService, writeLimiter: stack.writeLimiter }));
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

async function signIn(base) {
  const res = await fetch(`${base}/v1/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'member@example.com', password: 'correct-horse' }) });
  return (res.headers.get('set-cookie') || '').match(/tc_session=([^;]*)/)[1];
}

test('managing a membership requires a signed-in member', async () => {
  await withServer(makeStack(), async (base) => {
    assert.equal((await fetch(`${base}/v1/billing`)).status, 401);
    assert.equal((await fetch(`${base}/v1/billing/subscribe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"tier":"gold"}' })).status, 401);
    assert.equal((await fetch(`${base}/v1/billing/cancel`, { method: 'POST' })).status, 401);
  });
});

test('subscribe upgrades the tier, status reflects it, and cancel downgrades', async () => {
  await withServer(makeStack(), async (base) => {
    const token = await signIn(base);
    const cookie = `tc_session=${token}`;

    const sub = await fetch(`${base}/v1/billing/subscribe`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ tier: 'gold' }) });
    const subBody = await sub.json();
    assert.equal(sub.status, 200);
    assert.equal(subBody.data.member.tier, 'gold');
    assert.equal(subBody.data.subscription.tier, 'gold');

    // /v1/me reflects the upgrade (shared account store).
    const me = await (await fetch(`${base}/v1/me`, { headers: { cookie } })).json();
    assert.equal(me.data.tier, 'gold');
    assert.equal(me.data.subscriptionStatus, 'active');

    const status = await (await fetch(`${base}/v1/billing`, { headers: { cookie } })).json();
    assert.equal(status.data.subscriptionTier, 'gold');

    const cancel = await (await fetch(`${base}/v1/billing/cancel`, { method: 'POST', headers: { cookie } })).json();
    assert.equal(cancel.data.member.tier, 'free');
  });
});

test('subscribing to the free tier is a 400', async () => {
  await withServer(makeStack(), async (base) => {
    const cookie = `tc_session=${await signIn(base)}`;
    const res = await fetch(`${base}/v1/billing/subscribe`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ tier: 'free' }) });
    assert.equal(res.status, 400);
  });
});

test('the webhook fails closed when no secret is configured (503, no mutation)', async () => {
  await withServer(makeStack(), async (base) => {
    const res = await fetch(`${base}/v1/billing/webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_unknown' } } }) });
    assert.equal(res.status, 503);
  });
});

test('a correctly signed webhook is accepted and applied', async () => {
  const secret = 'whsec_test_secret';
  await withServer(makeStack({ webhookSecret: secret }), async (base) => {
    // An unsigned webhook is rejected...
    const bad = await fetch(`${base}/v1/billing/webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(bad.status, 401);

    // ...a correctly signed one is processed (unknown subscription -> applied:false).
    const payload = JSON.stringify({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_none' } } });
    const good = await fetch(`${base}/v1/billing/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': stripeSig(secret, payload) }, body: payload });
    assert.equal(good.status, 200);
    assert.equal((await good.json()).data.applied, false);
  });
});

test('a billing failure with no status code is masked as a 500', async () => {
  const store = new AccountStore({});
  const accountService = new AccountService({ store, sessions: createSessionManager({ secret: 'billing-test-secret' }) });
  const billingService = { status: () => ({}), async subscribe() { throw new Error('kaboom'); }, async cancel() { return {}; }, handleWebhook() { return {}; } };
  await withServer({ store, accountService, billingService }, async (base) => {
    const cookie = `tc_session=${await signIn(base)}`;
    const res = await fetch(`${base}/v1/billing/subscribe`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{"tier":"gold"}' });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error.message, 'Unexpected error');
  });
});

test('billing requests are rate-limited', async () => {
  const writeLimiter = new KeyedRateLimiter({ capacity: 1, refillPerMinute: 1 });
  await withServer(makeStack({ writeLimiter }), async (base) => {
    const cookie = `tc_session=${await signIn(base)}`;
    assert.equal((await fetch(`${base}/v1/billing`, { headers: { cookie } })).status, 200);
    const second = await fetch(`${base}/v1/billing`, { headers: { cookie } });
    assert.equal(second.status, 429);
    assert.ok(second.headers.get('retry-after'));
  });
});

test('billing routes 404 when billing is disabled', async () => {
  await withServer(makeStack({ billingEnabled: false }), async (base) => {
    assert.equal((await fetch(`${base}/v1/billing`)).status, 404);
    assert.equal((await fetch(`${base}/v1/billing/webhook`, { method: 'POST', body: '{}' })).status, 404);
  });
});

test('the method gate enforces POST-only billing actions and advertises billing', async () => {
  await withServer(makeStack(), async (base) => {
    const getSubscribe = await fetch(`${base}/v1/billing/subscribe`);
    assert.equal(getSubscribe.status, 405);
    assert.equal(getSubscribe.headers.get('allow'), 'POST, OPTIONS');

    const index = await (await fetch(`${base}/`, { headers: { accept: 'application/json' } })).json();
    assert.equal(index.data.endpoints.billing, '/v1/billing');
  });
});
