import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createStripeGateway } from '../../src/billing/paymentGateway.js';

const FIXED_NOW = 1_700_000_000_000; // fixed clock (ms) for deterministic ids/timestamps
const fixedNow = () => FIXED_NOW;

// A fake fetchJson that records the last request and returns a canned response.
function recorder(response) {
  const calls = [];
  const fetchJson = async (url, options) => {
    calls.push({ url, options });
    return response;
  };
  return { fetchJson, calls, last: () => calls[calls.length - 1] };
}

// A fetchJson that always rejects, to exercise the 502 wrapping.
function rejecter(err = new Error('boom')) {
  return async () => { throw err; };
}

// Build a valid Stripe-Signature header for a payload/secret/timestamp.
function signHeader(payload, secret, ts) {
  const v1 = createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex');
  return `t=${ts},v1=${v1}`;
}

// --- Gateway shape ----------------------------------------------------------

test('gateway reports name and live=false without a secret key', () => {
  const gw = createStripeGateway();
  assert.equal(gw.name, 'stripe');
  assert.equal(gw.live, false);
});

test('gateway reports live=true when a secret key is provided', () => {
  const gw = createStripeGateway({ secretKey: 'sk_test_123' });
  assert.equal(gw.live, true);
});

// --- Sandbox createCustomer -------------------------------------------------

test('sandbox createCustomer returns deterministic id and makes no network call', async () => {
  let called = false;
  const gw = createStripeGateway({ fetchJson: () => { called = true; } });
  const a = await gw.createCustomer({ email: 'ada@example.com', userId: 'u1' });
  const b = await gw.createCustomer({ email: 'ada@example.com', userId: 'u1' });
  assert.equal(called, false);
  assert.deepEqual(a, { customerId: 'cus_sandbox_u1' });
  assert.deepEqual(a, b);
});

test('createCustomer rejects a bad email', async () => {
  const gw = createStripeGateway();
  await assert.rejects(
    () => gw.createCustomer({ email: '', userId: 'u1' }),
    (err) => err.statusCode === 400 && err.message === 'A member email and id are required to set up billing'
  );
});

test('createCustomer rejects a bad userId', async () => {
  const gw = createStripeGateway();
  await assert.rejects(
    () => gw.createCustomer({ email: 'ada@example.com', userId: '   ' }),
    (err) => err.statusCode === 400
  );
});

// --- Sandbox createSubscription ---------------------------------------------

test('sandbox createSubscription is deterministic and uses the injected clock', async () => {
  const gw = createStripeGateway({ now: fixedNow });
  const a = await gw.createSubscription({ customerId: 'cus_1', priceId: 'price_x', tierId: 'gold' });
  const b = await gw.createSubscription({ customerId: 'cus_1', priceId: 'price_x', tierId: 'gold' });
  assert.deepEqual(a, {
    subscriptionId: 'sub_sandbox_cus_1_gold',
    status: 'active',
    currentPeriodEnd: FIXED_NOW + 30 * 24 * 60 * 60 * 1000,
    tierId: 'gold'
  });
  assert.deepEqual(a, b);
});

test('sandbox createSubscription uses the default now() when none is injected', async () => {
  const gw = createStripeGateway();
  const before = Date.now();
  const res = await gw.createSubscription({ customerId: 'cus_1', tierId: 'gold' });
  const after = Date.now();
  const window = 30 * 24 * 60 * 60 * 1000;
  assert.ok(res.currentPeriodEnd >= before + window && res.currentPeriodEnd <= after + window);
});

test('createSubscription rejects a missing customerId', async () => {
  const gw = createStripeGateway();
  await assert.rejects(
    () => gw.createSubscription({ tierId: 'gold' }),
    (err) => err.statusCode === 400 && err.message === 'A billing customer is required'
  );
});

// --- Sandbox cancelSubscription ---------------------------------------------

test('sandbox cancelSubscription returns canceled status', async () => {
  const gw = createStripeGateway();
  const res = await gw.cancelSubscription({ subscriptionId: 'sub_1' });
  assert.deepEqual(res, { subscriptionId: 'sub_1', status: 'canceled' });
});

test('cancelSubscription rejects a missing subscriptionId', async () => {
  const gw = createStripeGateway();
  await assert.rejects(
    () => gw.cancelSubscription({}),
    (err) => err.statusCode === 400 && err.message === 'A subscription id is required to cancel'
  );
});

// --- Sandbox charge ---------------------------------------------------------

test('sandbox charge is deterministic', async () => {
  const gw = createStripeGateway();
  const a = await gw.charge({ customerId: 'cus_1', amount: 12.5 });
  const b = await gw.charge({ customerId: 'cus_1', amount: 12.5 });
  assert.deepEqual(a, {
    paymentId: 'pi_sandbox_cus_1_1250',
    status: 'succeeded',
    amount: 12.5,
    currency: 'usd'
  });
  assert.deepEqual(a, b);
});

test('charge rejects a missing customer or non-positive amount', async () => {
  const gw = createStripeGateway();
  await assert.rejects(
    () => gw.charge({ customerId: '', amount: 10 }),
    (err) => err.statusCode === 400 && err.message === 'A customer and a positive amount are required to charge'
  );
  await assert.rejects(
    () => gw.charge({ customerId: 'cus_1', amount: 0 }),
    (err) => err.statusCode === 400
  );
  await assert.rejects(
    () => gw.charge({ customerId: 'cus_1', amount: Infinity }),
    (err) => err.statusCode === 400
  );
  await assert.rejects(
    () => gw.charge({ customerId: 'cus_1', amount: 'ten' }),
    (err) => err.statusCode === 400
  );
});

// --- Live createCustomer ----------------------------------------------------

test('live createCustomer posts a form body and reads the returned id', async () => {
  const rec = recorder({ id: 'cus_live_1' });
  const gw = createStripeGateway({ secretKey: 'sk_live_1', fetchJson: rec.fetchJson });
  const res = await gw.createCustomer({ email: 'ada@example.com', userId: 'u1' });
  assert.deepEqual(res, { customerId: 'cus_live_1' });

  const { url, options } = rec.last();
  assert.equal(url, 'https://api.stripe.com/v1/customers');
  assert.equal(options.method, 'POST');
  assert.equal(options.headers.Authorization, 'Bearer sk_live_1');
  assert.equal(options.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(typeof options.body, 'string');
  assert.match(options.body, /email=ada%40example.com/);
  assert.match(options.body, /metadata%5BuserId%5D=u1/);
});

test('live createCustomer wraps a fetch rejection into a 502', async () => {
  const cause = new Error('network down');
  const gw = createStripeGateway({ secretKey: 'sk_live_1', fetchJson: rejecter(cause) });
  await assert.rejects(
    () => gw.createCustomer({ email: 'ada@example.com', userId: 'u1' }),
    (err) => err.statusCode === 502 &&
      err.cause === cause &&
      err.message === 'The payment provider could not be reached right now. Please try again.'
  );
});

// --- Live createSubscription ------------------------------------------------

test('live createSubscription posts a form body and converts the period end to ms', async () => {
  const rec = recorder({ id: 'sub_live_1', status: 'active', current_period_end: 1_700_500_000 });
  const gw = createStripeGateway({ secretKey: 'sk_live_1', fetchJson: rec.fetchJson });
  const res = await gw.createSubscription({ customerId: 'cus_1', priceId: 'price_x', tierId: 'gold' });
  assert.deepEqual(res, {
    subscriptionId: 'sub_live_1',
    status: 'active',
    currentPeriodEnd: 1_700_500_000 * 1000,
    tierId: 'gold'
  });

  const { url, options } = rec.last();
  assert.equal(url, 'https://api.stripe.com/v1/subscriptions');
  assert.equal(options.method, 'POST');
  assert.equal(typeof options.body, 'string');
  assert.match(options.body, /customer=cus_1/);
  assert.match(options.body, /items%5B0%5D%5Bprice%5D=price_x/);
});

test('live createSubscription rejects when priceId is missing', async () => {
  const rec = recorder({ id: 'sub_live_1' });
  const gw = createStripeGateway({ secretKey: 'sk_live_1', fetchJson: rec.fetchJson });
  await assert.rejects(
    () => gw.createSubscription({ customerId: 'cus_1', tierId: 'gold' }),
    (err) => err.statusCode === 400 && err.message === 'A price is not configured for that tier'
  );
  assert.equal(rec.calls.length, 0);
});

test('live createSubscription wraps a fetch rejection into a 502', async () => {
  const cause = new Error('down');
  const gw = createStripeGateway({ secretKey: 'sk_live_1', fetchJson: rejecter(cause) });
  await assert.rejects(
    () => gw.createSubscription({ customerId: 'cus_1', priceId: 'price_x', tierId: 'gold' }),
    (err) => err.statusCode === 502 && err.cause === cause
  );
});

// --- Live cancelSubscription ------------------------------------------------

test('live cancelSubscription issues a DELETE with the encoded id and no body', async () => {
  const rec = recorder({ id: 'sub_live_1', status: 'canceled' });
  const gw = createStripeGateway({ secretKey: 'sk_live_1', fetchJson: rec.fetchJson });
  const res = await gw.cancelSubscription({ subscriptionId: 'sub/1' });
  assert.deepEqual(res, { subscriptionId: 'sub_live_1', status: 'canceled' });

  const { url, options } = rec.last();
  assert.equal(url, 'https://api.stripe.com/v1/subscriptions/sub%2F1');
  assert.equal(options.method, 'DELETE');
  assert.equal(options.body, undefined);
  assert.equal(options.headers.Authorization, 'Bearer sk_live_1');
});

test('live cancelSubscription wraps a fetch rejection into a 502', async () => {
  const cause = new Error('down');
  const gw = createStripeGateway({ secretKey: 'sk_live_1', fetchJson: rejecter(cause) });
  await assert.rejects(
    () => gw.cancelSubscription({ subscriptionId: 'sub_1' }),
    (err) => err.statusCode === 502 && err.cause === cause
  );
});

// --- Live charge ------------------------------------------------------------

test('live charge posts a payment intent form with description', async () => {
  const rec = recorder({ id: 'pi_live_1', status: 'succeeded' });
  const gw = createStripeGateway({ secretKey: 'sk_live_1', fetchJson: rec.fetchJson });
  const res = await gw.charge({ customerId: 'cus_1', amount: 20, currency: 'eur', description: 'Gold tier' });
  assert.deepEqual(res, { paymentId: 'pi_live_1', status: 'succeeded', amount: 20, currency: 'eur' });

  const { url, options } = rec.last();
  assert.equal(url, 'https://api.stripe.com/v1/payment_intents');
  assert.equal(options.method, 'POST');
  assert.equal(typeof options.body, 'string');
  assert.match(options.body, /customer=cus_1/);
  assert.match(options.body, /amount=2000/);
  assert.match(options.body, /currency=eur/);
  assert.match(options.body, /description=Gold\+tier/);
  assert.match(options.body, /confirm=true/);
  assert.match(options.body, /automatic_payment_methods%5Benabled%5D=true/);
});

test('live charge omits description when none is provided', async () => {
  const rec = recorder({ id: 'pi_live_2', status: 'succeeded' });
  const gw = createStripeGateway({ secretKey: 'sk_live_1', fetchJson: rec.fetchJson });
  await gw.charge({ customerId: 'cus_1', amount: 5 });
  assert.doesNotMatch(rec.last().options.body, /description=/);
});

test('live charge wraps a fetch rejection into a 502', async () => {
  const cause = new Error('down');
  const gw = createStripeGateway({ secretKey: 'sk_live_1', fetchJson: rejecter(cause) });
  await assert.rejects(
    () => gw.charge({ customerId: 'cus_1', amount: 10 }),
    (err) => err.statusCode === 502 && err.cause === cause
  );
});

// --- verifyWebhookSignature -------------------------------------------------

const SECRET = 'whsec_test';
const PAYLOAD = '{"id":"evt_1","type":"invoice.paid"}';
const NOW_SEC = Math.floor(FIXED_NOW / 1000);

test('verifyWebhookSignature accepts a valid signature', () => {
  const gw = createStripeGateway({ now: fixedNow });
  const header = signHeader(PAYLOAD, SECRET, NOW_SEC);
  assert.equal(gw.verifyWebhookSignature({ payload: PAYLOAD, signature: header, secret: SECRET }), true);
});

test('verifyWebhookSignature accepts when one of several v1 values matches', () => {
  const gw = createStripeGateway({ now: fixedNow });
  const good = createHmac('sha256', SECRET).update(`${NOW_SEC}.${PAYLOAD}`).digest('hex');
  // A wrong v1 of equal length, followed by the correct one, plus a stray key.
  const wrong = 'f'.repeat(good.length);
  const header = `t=${NOW_SEC},v0=ignored,v1=${wrong},v1=${good}`;
  assert.equal(gw.verifyWebhookSignature({ payload: PAYLOAD, signature: header, secret: SECRET }), true);
});

test('verifyWebhookSignature rejects a missing secret', () => {
  const gw = createStripeGateway({ now: fixedNow });
  const header = signHeader(PAYLOAD, SECRET, NOW_SEC);
  assert.equal(gw.verifyWebhookSignature({ payload: PAYLOAD, signature: header, secret: '' }), false);
});

test('verifyWebhookSignature rejects an empty signature', () => {
  const gw = createStripeGateway({ now: fixedNow });
  assert.equal(gw.verifyWebhookSignature({ payload: PAYLOAD, signature: '', secret: SECRET }), false);
});

test('verifyWebhookSignature rejects an empty payload', () => {
  const gw = createStripeGateway({ now: fixedNow });
  const header = signHeader('', SECRET, NOW_SEC);
  assert.equal(gw.verifyWebhookSignature({ payload: '', signature: header, secret: SECRET }), false);
});

test('verifyWebhookSignature rejects when no t is present', () => {
  const gw = createStripeGateway({ now: fixedNow });
  const v1 = createHmac('sha256', SECRET).update(`${NOW_SEC}.${PAYLOAD}`).digest('hex');
  // Header with a stray key and no '=' segment, but no t.
  assert.equal(gw.verifyWebhookSignature({ payload: PAYLOAD, signature: `bare,v1=${v1}`, secret: SECRET }), false);
});

test('verifyWebhookSignature rejects when no v1 is present', () => {
  const gw = createStripeGateway({ now: fixedNow });
  assert.equal(gw.verifyWebhookSignature({ payload: PAYLOAD, signature: `t=${NOW_SEC}`, secret: SECRET }), false);
});

test('verifyWebhookSignature rejects a non-numeric timestamp', () => {
  const gw = createStripeGateway({ now: fixedNow });
  assert.equal(gw.verifyWebhookSignature({ payload: PAYLOAD, signature: 't=abc,v1=deadbeef', secret: SECRET }), false);
});

test('verifyWebhookSignature rejects an expired timestamp', () => {
  const gw = createStripeGateway({ now: fixedNow });
  const oldTs = NOW_SEC - 10_000; // well beyond the default 300s tolerance
  const header = signHeader(PAYLOAD, SECRET, oldTs);
  assert.equal(gw.verifyWebhookSignature({ payload: PAYLOAD, signature: header, secret: SECRET }), false);
});

test('verifyWebhookSignature rejects a wrong v1 of matching length', () => {
  const gw = createStripeGateway({ now: fixedNow });
  const good = createHmac('sha256', SECRET).update(`${NOW_SEC}.${PAYLOAD}`).digest('hex');
  const wrong = 'a'.repeat(good.length);
  assert.equal(gw.verifyWebhookSignature({ payload: PAYLOAD, signature: `t=${NOW_SEC},v1=${wrong}`, secret: SECRET }), false);
});

test('verifyWebhookSignature rejects a length-mismatched v1 without throwing', () => {
  const gw = createStripeGateway({ now: fixedNow });
  assert.equal(gw.verifyWebhookSignature({ payload: PAYLOAD, signature: `t=${NOW_SEC},v1=short`, secret: SECRET }), false);
});

test('verifyWebhookSignature uses a default now() when none is injected', () => {
  const gw = createStripeGateway();
  const nowSec = Math.floor(Date.now() / 1000);
  const header = signHeader(PAYLOAD, SECRET, nowSec);
  assert.equal(gw.verifyWebhookSignature({ payload: PAYLOAD, signature: header, secret: SECRET }), true);
});

// --- parseWebhookEvent ------------------------------------------------------

test('parseWebhookEvent returns the parsed event', () => {
  const gw = createStripeGateway();
  const event = gw.parseWebhookEvent('{"id":"evt_1","type":"invoice.paid"}');
  assert.deepEqual(event, { id: 'evt_1', type: 'invoice.paid' });
});

test('parseWebhookEvent throws a 400 on invalid JSON', () => {
  const gw = createStripeGateway();
  assert.throws(
    () => gw.parseWebhookEvent('not json'),
    (err) => err.statusCode === 400 && err.message === 'Invalid webhook payload'
  );
});
