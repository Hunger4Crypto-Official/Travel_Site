import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { brand } from '../../src/config/brand.js';
import { handleRequest } from '../../src/routes/router.js';
import { AccountStore } from '../../src/accounts/accountStore.js';
import { AccountService } from '../../src/accounts/accountService.js';
import { createSessionManager } from '../../src/accounts/sessions.js';
import { OrderStore } from '../../src/booking/orderStore.js';
import { BookingService } from '../../src/booking/bookingService.js';
import { createDuffelAdapter } from '../../src/booking/duffelAdapter.js';
import { createBedbankAdapter } from '../../src/booking/bedbankAdapter.js';
import { lockOffer } from '../../src/booking/offerLock.js';
import { KeyedRateLimiter } from '../../src/utils/rateLimit.js';

const logger = { info() {}, warn() {}, error() {}, debug() {} };
const engine = {
  search: async () => ({}), flexibleSearch: async () => ({}), readiness: () => ({ ok: true }),
  metricsSnapshot: () => ({}), priceHistorySnapshot: () => ({}), createAlert: () => ({}), listAlerts: () => ({}), deleteAlert: () => ({})
};

function makeStack({ offerSecret = null, writeLimiter = null, booking = true } = {}) {
  const store = new AccountStore({});
  const accountService = new AccountService({ store, sessions: createSessionManager({ secret: 'order-test-secret' }) });
  const adapters = [createDuffelAdapter({ token: null }), createBedbankAdapter({})];
  const bookingService = booking ? new BookingService({ store: new OrderStore({}), adapters, offerSecret }) : null;
  return { accountService, bookingService, writeLimiter };
}

async function withServer(stack, fn) {
  const config = { allowedOrigins: ['*'], requireApiKey: false, apiKeys: [], sessionTtlMs: 604800000, cookieSecure: false };
  const server = createServer((req, res) => handleRequest(req, res, { engine, brand, logger, config, accountService: stack.accountService, bookingService: stack.bookingService, writeLimiter: stack.writeLimiter }));
  server.listen(0); await once(server, 'listening');
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); await once(server, 'close'); }
}

async function signIn(base, email = 'traveler@example.com') {
  const res = await fetch(`${base}/v1/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct-horse' }) });
  return `tc_session=${(res.headers.get('set-cookie') || '').match(/tc_session=([^;]*)/)[1]}`;
}

const flightOffer = { type: 'flights', id: 'off_abc', provider: 'duffel', title: 'LAX to JFK', price: { total: 300, base: 260, taxes: 40, fees: 0, currency: 'USD', estimated: false }, details: {} };
function bookBody(over = {}) {
  return JSON.stringify({ type: 'flights', offer: flightOffer, passengers: [{ givenName: 'Ada', familyName: 'Lovelace' }], contact: { email: 'ada@example.com' }, ...over });
}
const post = (base, cookie, body) => fetch(`${base}/v1/orders`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body });

test('orders require a signed-in caller (anonymous is 401)', async () => {
  await withServer(makeStack(), async (base) => {
    assert.equal((await fetch(`${base}/v1/orders`)).status, 401); // list
    assert.equal((await fetch(`${base}/v1/orders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: bookBody() })).status, 401);
    assert.equal((await fetch(`${base}/v1/orders/anything`)).status, 401);
  });
});

test('a signed-in member books, lists, fetches, and cancels', async () => {
  await withServer(makeStack(), async (base) => {
    const cookie = await signIn(base);
    const created = await (await post(base, cookie, bookBody())).json();
    assert.equal(created.data.status, 'confirmed');
    assert.equal(created.data.serviceFee, 6);
    const id = created.data.id;

    const list = await (await fetch(`${base}/v1/orders`, { headers: { cookie } })).json();
    assert.equal(list.data.count, 1);
    const one = await (await fetch(`${base}/v1/orders/${id}`, { headers: { cookie } })).json();
    assert.equal(one.data.id, id);
    const cancelled = await fetch(`${base}/v1/orders/${id}`, { method: 'DELETE', headers: { cookie } });
    assert.equal((await cancelled.json()).data.status, 'cancelled');
  });
});

test('one member cannot see or cancel another member order (owner-scoped)', async () => {
  await withServer(makeStack(), async (base) => {
    const alice = await signIn(base, 'alice@example.com');
    const created = await (await post(base, alice, bookBody())).json();
    const bob = await signIn(base, 'bob@example.com');
    assert.equal((await fetch(`${base}/v1/orders/${created.data.id}`, { headers: { cookie: bob } })).status, 404);
    assert.equal((await fetch(`${base}/v1/orders/${created.data.id}`, { method: 'DELETE', headers: { cookie: bob } })).status, 404);
    assert.equal((await (await fetch(`${base}/v1/orders`, { headers: { cookie: bob } })).json()).data.count, 0);
  });
});

test('booking validation errors and a malformed body surface as 400', async () => {
  await withServer(makeStack(), async (base) => {
    const cookie = await signIn(base);
    assert.equal((await post(base, cookie, bookBody({ passengers: [] }))).status, 400);
    assert.equal((await post(base, cookie, 'not json')).status, 400);
    // Passenger flooding is capped.
    const many = Array.from({ length: 10 }, () => ({ givenName: 'A', familyName: 'B' }));
    assert.equal((await post(base, cookie, bookBody({ passengers: many }))).status, 400);
  });
});

test('a signed offer is required to book when offer signing is on', async () => {
  const secret = 'offer-sign-secret';
  await withServer(makeStack({ offerSecret: secret }), async (base) => {
    const cookie = await signIn(base);
    // Fabricated / unsigned offer is refused.
    assert.equal((await post(base, cookie, bookBody())).status, 400);

    // A properly signed offer books.
    const signed = { ...flightOffer };
    signed.lock = lockOffer(secret, signed);
    assert.equal((await post(base, cookie, bookBody({ offer: signed }))).status, 201);

    // Tampering with the price after signing is rejected (no point farming).
    const tampered = { ...signed, price: { ...signed.price, total: 1 } };
    assert.equal((await post(base, cookie, bookBody({ offer: tampered }))).status, 400);
  });
});

test('a burst of bookings is throttled with a 429', async () => {
  const writeLimiter = new KeyedRateLimiter({ capacity: 1, refillPerMinute: 1 });
  await withServer(makeStack({ writeLimiter }), async (base) => {
    const cookie = await signIn(base);
    const first = await post(base, cookie, bookBody());
    assert.equal(first.status, 201);
    const second = await post(base, cookie, bookBody());
    assert.equal(second.status, 429);
    assert.ok(second.headers.get('retry-after'));
  });
});

test('orders 404 when booking is disabled, and an invalid order id is 400', async () => {
  await withServer(makeStack({ booking: false }), async (base) => {
    const cookie = await signIn(base);
    assert.equal((await fetch(`${base}/v1/orders`, { headers: { cookie } })).status, 404);
  });
  await withServer(makeStack(), async (base) => {
    const cookie = await signIn(base);
    // fetch() normalizes a stray '%', so send a raw request with a malformed
    // percent-encoding to reach the decode guard.
    const status = await new Promise((resolve, reject) => {
      const u = new URL(base);
      const req = httpRequest({ hostname: u.hostname, port: u.port, path: '/v1/orders/%zz', method: 'GET', headers: { cookie } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 400);
  });
});

test('the method gate enforces each order route verb set and the index advertises orders', async () => {
  await withServer(makeStack(), async (base) => {
    const putCollection = await fetch(`${base}/v1/orders`, { method: 'PUT' });
    assert.equal(putCollection.status, 405);
    assert.equal(putCollection.headers.get('allow'), 'GET, POST, OPTIONS');
    const postItem = await fetch(`${base}/v1/orders/abc`, { method: 'POST' });
    assert.equal(postItem.status, 405);
    assert.equal(postItem.headers.get('allow'), 'GET, DELETE, OPTIONS');
    const index = await (await fetch(`${base}/`, { headers: { accept: 'application/json' } })).json();
    assert.equal(index.data.endpoints.orders, '/v1/orders');
  });
});
