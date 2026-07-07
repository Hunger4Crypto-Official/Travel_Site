import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { brand } from '../../src/config/brand.js';
import { handleRequest } from '../../src/routes/router.js';
import { AccountStore } from '../../src/accounts/accountStore.js';
import { AccountService } from '../../src/accounts/accountService.js';
import { createSessionManager } from '../../src/accounts/sessions.js';

const logger = { info() {}, warn() {}, error() {}, debug() {} };

function fakeEngine(overrides = {}) {
  return {
    search: overrides.search || (async () => ({ query: {}, count: 0, offers: [], providers: [] })),
    flexibleSearch: overrides.flexibleSearch || (async () => ({ type: 'flights', calendar: [], cheapestDate: null })),
    readiness: () => ({ ok: true, providers: [] }),
    metricsSnapshot: () => ({ counters: {}, timings: {} }),
    priceHistorySnapshot: () => ({ type: 'flights', samples: 0 }),
    createAlert: overrides.createAlert || ((type, body, ctx) => ({ id: 'a1', type, owner: ctx.principal })),
    listAlerts: overrides.listAlerts || ((ctx) => ({ alerts: [], count: 0, owner: ctx.principal })),
    deleteAlert: overrides.deleteAlert || ((id) => ({ deleted: true, id }))
  };
}

function makeAccountService() {
  const store = new AccountStore({});
  const sessions = createSessionManager({ secret: 'unit-test-session-secret' });
  return new AccountService({ store, sessions });
}

async function withServer({ config, engine = fakeEngine(), accountService = makeAccountService() }, fn) {
  const server = createServer((req, res) => handleRequest(req, res, { engine, brand, logger, config, accountService }));
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

const baseConfig = { allowedOrigins: ['*'], requireApiKey: false, apiKeys: [], sessionTtlMs: 604800000, cookieSecure: false };

function cookieToken(res) {
  const header = res.headers.get('set-cookie') || '';
  const match = header.match(/tc_session=([^;]*)/);
  return match ? match[1] : null;
}

async function signup(base, email = 'user@example.com', password = 'correct-horse') {
  const res = await fetch(`${base}/v1/auth/signup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  return { res, token: cookieToken(res), body: await res.json() };
}

test('signup returns 201, a public user, and a session cookie', async () => {
  await withServer({ config: baseConfig }, async (base) => {
    const { res, token, body } = await signup(base);
    assert.equal(res.status, 201);
    const setCookie = res.headers.get('set-cookie');
    assert.match(setCookie, /tc_session=/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.doesNotMatch(setCookie, /Secure/); // cookieSecure=false
    assert.ok(token);
    assert.equal(body.data.user.email, 'user@example.com');
    assert.equal(body.data.user.tier, 'free');
    assert.equal(body.data.user.passwordHash, undefined);
    assert.match(body.meta.principal, /^user:/);
  });
});

test('a duplicate signup is a 409, a malformed body is 400, a bad email is 400', async () => {
  await withServer({ config: baseConfig }, async (base) => {
    await signup(base, 'dupe@example.com');
    const dup = await signup(base, 'dupe@example.com');
    assert.equal(dup.res.status, 409);

    const malformed = await fetch(`${base}/v1/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' });
    assert.equal(malformed.status, 400);
    assert.match((await malformed.json()).error.message, /valid JSON/);

    const badEmail = await signup(base, 'nope');
    assert.equal(badEmail.res.status, 400);
  });
});

test('login succeeds with a cookie, fails 401 on a wrong password', async () => {
  await withServer({ config: baseConfig }, async (base) => {
    await signup(base, 'log@example.com', 'correct-horse');
    const okRes = await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'log@example.com', password: 'correct-horse' }) });
    assert.equal(okRes.status, 200);
    assert.ok(cookieToken(okRes));

    const badRes = await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'log@example.com', password: 'wrong-password' }) });
    assert.equal(badRes.status, 401);
  });
});

test('/v1/me needs a valid session cookie', async () => {
  await withServer({ config: baseConfig }, async (base) => {
    const anon = await fetch(`${base}/v1/me`);
    assert.equal(anon.status, 401);

    // A cookie header without our key, and one with a garbage token, both 401.
    const other = await fetch(`${base}/v1/me`, { headers: { cookie: 'other=1; malformed' } });
    assert.equal(other.status, 401);
    const garbage = await fetch(`${base}/v1/me`, { headers: { cookie: 'tc_session=not-a-real-token' } });
    assert.equal(garbage.status, 401);

    const { token } = await signup(base, 'me@example.com');
    const me = await fetch(`${base}/v1/me`, { headers: { cookie: `tc_session=${token}` } });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).data.email, 'me@example.com');
  });
});

test('logout clears the cookie', async () => {
  await withServer({ config: baseConfig }, async (base) => {
    const res = await fetch(`${base}/v1/auth/logout`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('set-cookie'), /tc_session=;/);
    assert.match(res.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal((await res.json()).data.signedOut, true);
  });
});

test('logout marks the cleared cookie Secure when configured', async () => {
  await withServer({ config: { ...baseConfig, cookieSecure: true } }, async (base) => {
    const res = await fetch(`${base}/v1/auth/logout`, { method: 'POST' });
    assert.match(res.headers.get('set-cookie'), /Secure/);
  });
});

test('auth routes 404 when accounts are disabled', async () => {
  await withServer({ config: baseConfig, accountService: null }, async (base) => {
    assert.equal((await fetch(`${base}/v1/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404);
    assert.equal((await fetch(`${base}/v1/me`)).status, 404);
  });
});

test('the method gate rejects the wrong verb per route', async () => {
  await withServer({ config: baseConfig }, async (base) => {
    const getSignup = await fetch(`${base}/v1/auth/signup`);
    assert.equal(getSignup.status, 405);
    assert.equal(getSignup.headers.get('allow'), 'POST, OPTIONS');

    const postMe = await fetch(`${base}/v1/me`, { method: 'POST' });
    assert.equal(postMe.status, 405);
    assert.equal(postMe.headers.get('allow'), 'GET, OPTIONS');
  });
});

test('cookieSecure adds the Secure attribute', async () => {
  await withServer({ config: { ...baseConfig, cookieSecure: true } }, async (base) => {
    const { res } = await signup(base, 'secure@example.com');
    assert.match(res.headers.get('set-cookie'), /Secure/);
  });
});

test('a signed-in session satisfies auth and scopes ownership to the user', async () => {
  const config = { ...baseConfig, requireApiKey: true, apiKeys: ['api-key-1'] };
  await withServer({ config }, async (base) => {
    // Search is blocked without any credential...
    assert.equal((await fetch(`${base}/v1/flights/search?from=LAX&to=JFK`)).status, 401);

    const { token, body } = await signup(base, 'owner@example.com');
    const userPrincipal = body.meta.principal;

    // ...but a session cookie unlocks it, and the principal is the user.
    const search = await fetch(`${base}/v1/flights/search?from=LAX&to=JFK`, { headers: { cookie: `tc_session=${token}` } });
    assert.equal(search.status, 200);
    assert.equal((await search.json()).meta.principal, userPrincipal);

    // A created alert is owned by that same user principal.
    const alert = await fetch(`${base}/v1/alerts`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: `tc_session=${token}` },
      body: JSON.stringify({ type: 'flights', from: 'LAX', to: 'JFK', date: '2027-05-01' })
    });
    assert.equal((await alert.json()).data.owner, userPrincipal);

    // The ops-only /metrics path is NOT satisfied by a consumer session.
    assert.equal((await fetch(`${base}/metrics`, { headers: { cookie: `tc_session=${token}` } })).status, 401);
  });
});

test('the service index and 404 route list advertise the auth endpoints', async () => {
  await withServer({ config: baseConfig }, async (base) => {
    const index = await (await fetch(`${base}/`, { headers: { accept: 'application/json' } })).json();
    assert.equal(index.data.endpoints.signup, '/v1/auth/signup');
    assert.equal(index.data.endpoints.login, '/v1/auth/login');
    assert.equal(index.data.endpoints.me, '/v1/me');

    const notFound = await (await fetch(`${base}/nope`)).json();
    assert.ok(notFound.error.details.availableRoutes.includes('/v1/auth/signup'));
    assert.ok(notFound.error.details.availableRoutes.includes('/v1/me'));
  });
});
