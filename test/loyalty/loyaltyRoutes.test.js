import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { brand } from '../../src/config/brand.js';
import { handleRequest } from '../../src/routes/router.js';
import { AccountStore } from '../../src/accounts/accountStore.js';
import { AccountService } from '../../src/accounts/accountService.js';
import { createSessionManager } from '../../src/accounts/sessions.js';
import { createLoyaltyService } from '../../src/loyalty/index.js';
import { createBookingService } from '../../src/booking/index.js';

const logger = { info() {}, warn() {}, error() {}, debug() {} };
const engine = {
  search: async () => ({}), flexibleSearch: async () => ({}), readiness: () => ({ ok: true }),
  metricsSnapshot: () => ({}), priceHistorySnapshot: () => ({}), createAlert: () => ({}), listAlerts: () => ({}), deleteAlert: () => ({})
};
const bookingConfig = { bookingEnabled: true, ordersFile: null, ordersMaxEntries: 100, duffelToken: null, duffelEnv: 'test', hotelbedsApiKey: null, hotelbedsSecret: null, hotelbedsEnv: 'test', providerTimeoutMs: 8000 };
const loyaltyConfig = { loyaltyEnabled: true, loyaltyFile: null, loyaltyMaxEntries: 100 };

function makeStack({ loyaltyEnabled = true } = {}) {
  const store = new AccountStore({});
  const accountService = new AccountService({ store, sessions: createSessionManager({ secret: 'loyalty-test-secret' }) });
  const loyaltyService = createLoyaltyService({ ...loyaltyConfig, loyaltyEnabled }, loyaltyEnabled ? store : null);
  const bookingService = createBookingService(bookingConfig, { loyalty: loyaltyService });
  return { accountService, loyaltyService, bookingService };
}

async function withServer(stack, fn) {
  const config = { allowedOrigins: ['*'], requireApiKey: false, apiKeys: [], sessionTtlMs: 604800000, cookieSecure: false };
  const server = createServer((req, res) => handleRequest(req, res, { engine, brand, logger, config, accountService: stack.accountService, bookingService: stack.bookingService, loyaltyService: stack.loyaltyService }));
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
  const res = await fetch(`${base}/v1/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'earner@example.com', password: 'correct-horse' }) });
  return (res.headers.get('set-cookie') || '').match(/tc_session=([^;]*)/)[1];
}

function bookFlight(base, cookie) {
  return fetch(`${base}/v1/orders`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'flights', offer: { type: 'flights', id: 'off_l', price: { total: 300, currency: 'USD' } }, passengers: [{ givenName: 'Ada', familyName: 'Lovelace' }], contact: { email: 'ada@x.com' } })
  });
}

test('viewing loyalty requires a signed-in member', async () => {
  await withServer(makeStack(), async (base) => {
    assert.equal((await fetch(`${base}/v1/loyalty`)).status, 401);
    assert.equal((await fetch(`${base}/v1/loyalty/redeem`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"points":10}' })).status, 401);
  });
});

test('booking earns points, which appear in the balance and can be redeemed', async () => {
  await withServer(makeStack(), async (base) => {
    const cookie = `tc_session=${await signIn(base)}`;

    const order = await (await bookFlight(base, cookie)).json();
    assert.equal(order.data.loyaltyEarned, 300, 'free tier earns 1x the trip total');

    const balance = await (await fetch(`${base}/v1/loyalty`, { headers: { cookie } })).json();
    assert.equal(balance.data.balance, 300);
    assert.equal(balance.data.transactions.length, 1);

    const redeemed = await fetch(`${base}/v1/loyalty/redeem`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ points: 100 }) });
    const redeemedBody = await redeemed.json();
    assert.equal(redeemed.status, 200);
    assert.equal(redeemedBody.data.balance, 200);
    assert.equal(redeemedBody.data.creditUsd, 1);

    const tooMuch = await fetch(`${base}/v1/loyalty/redeem`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ points: 99999 }) });
    assert.equal(tooMuch.status, 400);
  });
});

test('loyalty routes 404 when loyalty is disabled', async () => {
  await withServer(makeStack({ loyaltyEnabled: false }), async (base) => {
    assert.equal((await fetch(`${base}/v1/loyalty`)).status, 404);
  });
});

test('the method gate makes redeem POST-only and the index advertises loyalty', async () => {
  await withServer(makeStack(), async (base) => {
    const getRedeem = await fetch(`${base}/v1/loyalty/redeem`);
    assert.equal(getRedeem.status, 405);
    assert.equal(getRedeem.headers.get('allow'), 'POST, OPTIONS');

    const index = await (await fetch(`${base}/`, { headers: { accept: 'application/json' } })).json();
    assert.equal(index.data.endpoints.loyalty, '/v1/loyalty');
  });
});
