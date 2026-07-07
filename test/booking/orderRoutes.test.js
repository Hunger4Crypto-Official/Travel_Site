import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { brand } from '../../src/config/brand.js';
import { handleRequest } from '../../src/routes/router.js';
import { OrderStore } from '../../src/booking/orderStore.js';
import { BookingService } from '../../src/booking/bookingService.js';
import { createDuffelAdapter } from '../../src/booking/duffelAdapter.js';
import { createBedbankAdapter } from '../../src/booking/bedbankAdapter.js';

const logger = { info() {}, warn() {}, error() {}, debug() {} };
const engine = {
  search: async () => ({ query: {}, count: 0, offers: [], providers: [] }),
  flexibleSearch: async () => ({}), readiness: () => ({ ok: true }), metricsSnapshot: () => ({}),
  priceHistorySnapshot: () => ({}), createAlert: () => ({}), listAlerts: () => ({}), deleteAlert: () => ({})
};

function sandboxBooking() {
  const store = new OrderStore({});
  const adapters = [createDuffelAdapter({ token: null }), createBedbankAdapter({})];
  return new BookingService({ store, adapters });
}

async function withServer({ config, bookingService = sandboxBooking() }, fn) {
  const server = createServer((req, res) => handleRequest(req, res, { engine, brand, logger, config, bookingService }));
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

const config = { allowedOrigins: ['*'], requireApiKey: false, apiKeys: [] };
const flightOffer = {
  type: 'flights', id: 'off_abc', provider: 'duffel', title: 'LAX to JFK',
  price: { total: 300, base: 260, taxes: 40, fees: 0, currency: 'USD', estimated: false }, details: {}
};
function bookBody(over = {}) {
  return JSON.stringify({ type: 'flights', offer: flightOffer, passengers: [{ givenName: 'Ada', familyName: 'Lovelace' }], contact: { email: 'ada@example.com' }, ...over });
}

test('POST /v1/orders books a flight end to end (sandbox) and returns 201', async () => {
  await withServer({ config }, async (base) => {
    const res = await fetch(`${base}/v1/orders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: bookBody() });
    const body = await res.json();
    assert.equal(res.status, 201);
    assert.equal(body.data.status, 'confirmed');
    assert.equal(body.data.provider, 'duffel');
    assert.equal(body.data.providerRef, 'duffel_sandbox_off_abc');
    assert.equal(body.data.serviceFee, 6, '2% of 300 for a free-tier caller');
    assert.equal(body.data.total, 306);
    assert.ok(body.data.confirmation);
  });
});

test('GET /v1/orders lists, GET /v1/orders/<id> fetches, DELETE cancels', async () => {
  await withServer({ config }, async (base) => {
    const created = await (await fetch(`${base}/v1/orders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: bookBody() })).json();
    const id = created.data.id;

    const list = await (await fetch(`${base}/v1/orders`)).json();
    assert.equal(list.data.count, 1);

    const one = await (await fetch(`${base}/v1/orders/${id}`)).json();
    assert.equal(one.data.id, id);

    const cancelled = await fetch(`${base}/v1/orders/${id}`, { method: 'DELETE' });
    assert.equal(cancelled.status, 200);
    assert.equal((await cancelled.json()).data.status, 'cancelled');
  });
});

test('booking validation errors surface as 400', async () => {
  await withServer({ config }, async (base) => {
    const noPax = await fetch(`${base}/v1/orders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: bookBody({ passengers: [] }) });
    assert.equal(noPax.status, 400);
    const badBody = await fetch(`${base}/v1/orders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' });
    assert.equal(badBody.status, 400);
  });
});

test('a fetch for someone else\'s order is a 404', async () => {
  await withServer({ config }, async (base) => {
    const res = await fetch(`${base}/v1/orders/does-not-exist`);
    assert.equal(res.status, 404);
  });
});

test('orders 404 when booking is disabled', async () => {
  await withServer({ config, bookingService: null }, async (base) => {
    assert.equal((await fetch(`${base}/v1/orders`)).status, 404);
    assert.equal((await fetch(`${base}/v1/orders/x`)).status, 404);
  });
});

test('the method gate enforces each order route\'s verb set', async () => {
  await withServer({ config }, async (base) => {
    const putCollection = await fetch(`${base}/v1/orders`, { method: 'PUT' });
    assert.equal(putCollection.status, 405);
    assert.equal(putCollection.headers.get('allow'), 'GET, POST, OPTIONS');

    const postItem = await fetch(`${base}/v1/orders/abc`, { method: 'POST' });
    assert.equal(postItem.status, 405);
    assert.equal(postItem.headers.get('allow'), 'GET, DELETE, OPTIONS');
  });
});

test('the service index and 404 list advertise /v1/orders', async () => {
  await withServer({ config }, async (base) => {
    const index = await (await fetch(`${base}/`, { headers: { accept: 'application/json' } })).json();
    assert.equal(index.data.endpoints.orders, '/v1/orders');
    const notFound = await (await fetch(`${base}/nope`)).json();
    assert.ok(notFound.error.details.availableRoutes.includes('/v1/orders'));
  });
});
