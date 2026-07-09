import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { brand } from '../src/config/brand.js';
import { handleRequest } from '../src/routes/router.js';
import { AccountStore } from '../src/accounts/accountStore.js';
import { AccountService } from '../src/accounts/accountService.js';
import { createSessionManager } from '../src/accounts/sessions.js';
import { OrderStore } from '../src/booking/orderStore.js';
import { BookingService } from '../src/booking/bookingService.js';
import { createDuffelAdapter } from '../src/booking/duffelAdapter.js';
import { createBedbankAdapter } from '../src/booking/bedbankAdapter.js';
import { createBillingService } from '../src/billing/index.js';
import { IdempotencyStore } from '../src/utils/idempotencyStore.js';
import { AuditLog } from '../src/observability/auditLog.js';
import { createPublicHolidays } from '../src/enrichment/publicHolidays.js';

const logger = { info() {}, warn() {}, error() {}, debug() {} };
const engine = {
  search: async () => ({}), flexibleSearch: async () => ({}), readiness: () => ({ ok: true }),
  metricsSnapshot: () => ({ counters: { requests_total: 3 }, timings: { search: { count: 2, totalMs: 10, maxMs: 7, averageMs: 5 } } }),
  priceHistorySnapshot: () => ({}), createAlert: () => ({}), listAlerts: () => ({}), deleteAlert: () => ({})
};

const billingConfig = { billingEnabled: true, stripeSecretKey: null, stripeWebhookSecret: null, stripePriceSilver: null, stripePriceGold: null, providerTimeoutMs: 8000 };

function makeStack(extra = {}) {
  const store = new AccountStore({});
  const accountService = new AccountService({ store, sessions: createSessionManager({ secret: 'harden-test-secret' }) });
  const adapters = [createDuffelAdapter({ token: null }), createBedbankAdapter({})];
  const bookingService = new BookingService({ store: new OrderStore({}), adapters, offerSecret: null });
  const billingService = createBillingService(billingConfig, store);
  return { accountService, bookingService, billingService, idempotencyStore: new IdempotencyStore(), auditLog: new AuditLog({}), ...extra };
}

async function withServer(stack, fn) {
  const config = { allowedOrigins: ['*'], requireApiKey: false, apiKeys: [], sessionTtlMs: 604800000, cookieSecure: false, trustProxyHops: 0 };
  const server = createServer((req, res) => handleRequest(req, res, {
    engine, brand, logger, config,
    accountService: stack.accountService, bookingService: stack.bookingService, billingService: stack.billingService,
    idempotencyStore: stack.idempotencyStore, auditLog: stack.auditLog, holidays: stack.holidays
  }));
  server.listen(0);
  await once(server, 'listening');
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

test('an Idempotency-Key replays the first booking response instead of double-booking', async () => {
  const stack = makeStack();
  await withServer(stack, async (base) => {
    const cookie = await signIn(base);
    const headers = { 'content-type': 'application/json', cookie, 'idempotency-key': 'key-123' };
    const first = await fetch(`${base}/v1/orders`, { method: 'POST', headers, body: bookBody() });
    assert.equal(first.status, 201);
    assert.equal(first.headers.get('idempotent-replay'), null);
    const firstBody = await first.json();

    const second = await fetch(`${base}/v1/orders`, { method: 'POST', headers, body: bookBody() });
    assert.equal(second.status, 201);
    assert.equal(second.headers.get('idempotent-replay'), 'true');
    const secondBody = await second.json();
    // Same order id: the second call replayed rather than creating a new order.
    assert.equal(secondBody.data.id, firstBody.data.id);

    // Exactly one order exists for the member.
    const list = await (await fetch(`${base}/v1/orders`, { headers: { cookie } })).json();
    assert.equal(list.data.count, 1);
  });
});

test('a different Idempotency-Key creates a distinct order', async () => {
  const stack = makeStack();
  await withServer(stack, async (base) => {
    const cookie = await signIn(base);
    const mk = (key) => fetch(`${base}/v1/orders`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'idempotency-key': key }, body: bookBody() });
    const a = await (await mk('aaa')).json();
    const b = await (await mk('bbb')).json();
    assert.notEqual(a.data.id, b.data.id);
    const list = await (await fetch(`${base}/v1/orders`, { headers: { cookie } })).json();
    assert.equal(list.data.count, 2);
  });
});

test('an Idempotency-Key replays a membership subscription instead of charging twice', async () => {
  const stack = makeStack();
  await withServer(stack, async (base) => {
    const cookie = await signIn(base);
    const headers = { 'content-type': 'application/json', cookie, 'idempotency-key': 'sub-1' };
    const first = await fetch(`${base}/v1/billing/subscribe`, { method: 'POST', headers, body: JSON.stringify({ tier: 'silver' }) });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('idempotent-replay'), null);
    const second = await fetch(`${base}/v1/billing/subscribe`, { method: 'POST', headers, body: JSON.stringify({ tier: 'silver' }) });
    assert.equal(second.headers.get('idempotent-replay'), 'true');
    const actions = stack.auditLog.list().map((e) => e.action);
    assert.ok(actions.includes('billing.subscribe'));
  });
});

test('audit log records signup and order creation with a redacted trail', async () => {
  const stack = makeStack();
  await withServer(stack, async (base) => {
    const cookie = await signIn(base);
    await fetch(`${base}/v1/orders`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: bookBody() });
    const actions = stack.auditLog.list().map((e) => e.action);
    assert.ok(actions.includes('account.signup'));
    assert.ok(actions.includes('order.create'));
  });
});

test('/metrics negotiates Prometheus text vs JSON', async () => {
  await withServer(makeStack(), async (base) => {
    const prom = await fetch(`${base}/metrics`, { headers: { accept: 'text/plain' } });
    assert.match(prom.headers.get('content-type'), /text\/plain/);
    const text = await prom.text();
    assert.match(text, /ttc_requests_total/);
    assert.match(text, /# TYPE ttc_requests_total counter/);

    const promQuery = await fetch(`${base}/metrics?format=prometheus`);
    assert.match(promQuery.headers.get('content-type'), /text\/plain/);

    const json = await fetch(`${base}/metrics`, { headers: { accept: 'application/json' } });
    assert.match(json.headers.get('content-type'), /application\/json/);
    const body = await json.json();
    assert.equal(body.data.counters.requests_total, 3);
  });
});

test('/v1/holidays returns 404 when the enrichment is disabled', async () => {
  await withServer(makeStack(), async (base) => {
    const res = await fetch(`${base}/v1/holidays?country=US&year=2026`);
    assert.equal(res.status, 404);
  });
});

test('/v1/holidays serves upstream holidays when enabled', async () => {
  const fetchJson = async () => ([
    { date: '2026-01-01', localName: 'New Year', name: "New Year's Day", global: true, types: ['Public'] }
  ]);
  const holidays = createPublicHolidays({ fetchJson, enabled: true });
  await withServer(makeStack({ holidays }), async (base) => {
    const res = await fetch(`${base}/v1/holidays?country=US&year=2026`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.countryCode, 'US');
    assert.equal(body.data.count, 1);
    assert.equal(body.data.holidays[0].localName, 'New Year');
    assert.equal(body.data.holidays[0].nationwide, true);
  });
});

test('/v1/holidays surfaces a 400 for an invalid country', async () => {
  const fetchJson = async () => ([]);
  const holidays = createPublicHolidays({ fetchJson, enabled: true });
  await withServer(makeStack({ holidays }), async (base) => {
    const res = await fetch(`${base}/v1/holidays?country=USA&year=2026`);
    assert.equal(res.status, 400);
  });
});
