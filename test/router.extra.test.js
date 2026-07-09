import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { brand } from '../src/config/brand.js';
import { handleRequest, clientIp, wantsHtml, originAllowed } from '../src/routes/router.js';

const logger = { info() {}, warn() {}, error() {}, debug() {} };

// A configurable fake engine so we can drive every router branch deterministically.
function fakeEngine(overrides = {}) {
  return {
    search: overrides.search || (async () => ({ query: {}, count: 0, offers: [], providers: [] })),
    flexibleSearch: overrides.flexibleSearch || (async () => ({ type: 'flights', calendar: [], cheapestDate: null })),
    readiness: overrides.readiness || (() => ({ ok: true, providers: [] })),
    metricsSnapshot: overrides.metricsSnapshot || (() => ({ counters: {}, timings: {} })),
    priceHistorySnapshot: overrides.priceHistorySnapshot || (() => ({ type: 'flights', key: 'LAX-JFK', samples: 0 })),
    createAlert: overrides.createAlert || ((type, body) => ({ id: 'a1', type, threshold: body.threshold ?? null })),
    listAlerts: overrides.listAlerts || (() => ({ alerts: [], count: 0 })),
    deleteAlert: overrides.deleteAlert || ((id) => ({ deleted: true, id }))
  };
}

async function withServer(config, engine, fn, openapiSpec = null, pages = {}) {
  const server = createServer((req, res) => handleRequest(req, res, { engine, brand, logger, config, openapiSpec, pages }));
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

const openConfig = { allowedOrigins: ['*'], requireApiKey: false, apiKeys: [] };

test('root index lists endpoints and is cacheable', async () => {
  await withServer(openConfig, fakeEngine(), async (base) => {
    const res = await fetch(`${base}/`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=300');
    assert.equal(body.data.endpoints.flights.startsWith('/v1/flights/search'), true);
    assert.equal(body.data.documentation, '/openapi.yaml');
    assert.equal(body.meta.version, '1.0.0');
  });
});

test('OpenAPI spec is served as YAML when available, 404 otherwise', async () => {
  const spec = 'openapi: 3.1.0\ninfo:\n  title: test\n';
  await withServer(openConfig, fakeEngine(), async (base) => {
    const res = await fetch(`${base}/openapi.yaml`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /yaml/);
    assert.match(await res.text(), /openapi: 3\.1\.0/);
  }, spec);

  await withServer(openConfig, fakeEngine(), async (base) => {
    assert.equal((await fetch(`${base}/openapi.yaml`)).status, 404);
  });
});

test('responses carry a consistent envelope (source, version, requestId, brand)', async () => {
  await withServer(openConfig, fakeEngine(), async (base) => {
    const res = await fetch(`${base}/v1/flights/search?from=LAX&to=JFK`);
    const body = await res.json();
    assert.equal(body.source, 'the-travel-club');
    assert.equal(body.meta.version, '1.0.0');
    assert.equal(body.meta.brand.name, brand.name);
    assert.equal(Boolean(body.meta.requestId), true);
  });
});

test('429 responses include a Retry-After header and retryAfter detail', async () => {
  const limited = fakeEngine({ search: async () => { const e = new Error('Rate limit exceeded'); e.statusCode = 429; e.retryAfter = 30; e.publicDetails = { retryAfter: 30 }; throw e; } });
  await withServer(openConfig, limited, async (base) => {
    const res = await fetch(`${base}/v1/flights/search?from=LAX&to=JFK`);
    const body = await res.json();
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('retry-after'), '30');
    assert.equal(body.error.details.retryAfter, 30);
  });
});

test('OPTIONS preflight returns 204 and CORS wildcard echoes origin', async () => {
  await withServer(openConfig, fakeEngine(), async (base) => {
    const res = await fetch(`${base}/v1/flights/search`, { method: 'OPTIONS', headers: { origin: 'https://any.example' } });
    assert.equal(res.status, 204);
    // Wildcard config emits a literal '*' rather than reflecting the origin.
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  });
});

test('non-GET methods are rejected with 405 and an Allow header', async () => {
  await withServer(openConfig, fakeEngine(), async (base) => {
    const res = await fetch(`${base}/v1/flights/search`, { method: 'POST' });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'GET, OPTIONS');
  });
});

test('unknown routes return a structured 404 listing available routes', async () => {
  await withServer(openConfig, fakeEngine(), async (base) => {
    const res = await fetch(`${base}/nope`);
    const body = await res.json();
    assert.equal(res.status, 404);
    assert.equal(body.error.statusCode, 404);
    assert.ok(body.error.details.availableRoutes.includes('/v1/flights/search'));
  });
});

test('a trailing slash resolves to the same route instead of 404', async () => {
  const seen = [];
  const engine = fakeEngine({ search: async (type) => { seen.push(type); return { query: {}, count: 0, offers: [], providers: [] }; } });
  await withServer(openConfig, engine, async (base) => {
    const res = await fetch(`${base}/v1/flights/search/?from=LAX&to=JFK`);
    assert.equal(res.status, 200);
    assert.deepEqual(seen, ['flights']);
  });
});

const samplePages = { app: '<!doctype html><title>App</title><h1>THE Travel Club</h1>', admin: '<!doctype html><title>Ops</title><h1>Console</h1>' };

test('the root negotiates: browsers get the app, API clients get JSON', async () => {
  await withServer(openConfig, fakeEngine(), async (base) => {
    const html = await fetch(`${base}/`, { headers: { accept: 'text/html,application/xhtml+xml' } });
    assert.equal(html.status, 200);
    assert.match(html.headers.get('content-type'), /text\/html/);
    assert.match(await html.text(), /THE Travel Club/);

    const json = await fetch(`${base}/`, { headers: { accept: 'application/json' } });
    assert.match(json.headers.get('content-type'), /application\/json/);
    const body = await json.json();
    assert.equal(body.data.endpoints.app, '/app');
    assert.equal(body.data.endpoints.admin, '/admin');
  }, null, samplePages);
});

test('the root falls back to JSON when no app page is available', async () => {
  await withServer(openConfig, fakeEngine(), async (base) => {
    const res = await fetch(`${base}/`, { headers: { accept: 'text/html' } });
    assert.match(res.headers.get('content-type'), /application\/json/);
  });
});

test('/app and /admin serve their pages, and 404 when not deployed', async () => {
  await withServer(openConfig, fakeEngine(), async (base) => {
    const app = await fetch(`${base}/app`);
    assert.equal(app.status, 200);
    assert.match(await app.text(), /THE Travel Club/);
    const admin = await fetch(`${base}/admin`);
    assert.equal(admin.status, 200);
    assert.match(admin.headers.get('content-type'), /text\/html/);
    assert.match(await admin.text(), /Console/);
  }, null, samplePages);

  await withServer(openConfig, fakeEngine(), async (base) => {
    assert.equal((await fetch(`${base}/app`)).status, 404);
    assert.equal((await fetch(`${base}/admin`)).status, 404);
  });
});

test('/v1/trust is public, cacheable, and lists the published commitments', async () => {
  const cfg = { allowedOrigins: ['*'], requireApiKey: true, apiKeys: ['k'] }; // auth required for search...
  await withServer(cfg, fakeEngine(), async (base) => {
    const res = await fetch(`${base}/v1/trust`); // ...but the manifest needs no key
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=300');
    const ids = body.data.commitments.map((c) => c.id);
    assert.deepEqual(ids, ['all-in-pricing', 'no-fake-urgency', 'no-paid-ranking', 'freshness-disclosure', 'honest-failures', 'price-context', 'honest-booking-totals', 'easy-cancellation', 'transparent-membership', 'assistive-ai-only', 'data-protection']);
    assert.ok(body.data.commitments.every((c) => c.promise && c.mechanism));
  });
});

test('/v1/prices/history proxies the engine snapshot and surfaces its errors', async () => {
  const seen = [];
  const engine = fakeEngine({
    priceHistorySnapshot: (type, query) => { seen.push([type, query.from]); return { type, key: 'LAX-JFK', samples: 2, average: 120 }; }
  });
  await withServer(openConfig, engine, async (base) => {
    const res = await fetch(`${base}/v1/prices/history?type=flights&from=LAX&to=JFK`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.data.average, 120);
    assert.deepEqual(seen[0], ['flights', 'LAX']);
  });

  const failing = fakeEngine({
    priceHistorySnapshot: () => { const e = new Error('Invalid type. Expected one of: flights, hotels, cars'); e.statusCode = 400; throw e; }
  });
  await withServer(openConfig, failing, async (base) => {
    const res = await fetch(`${base}/v1/prices/history?type=cruises`);
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.match(body.error.message, /Invalid type/);
  });
});

test('unknown-route 404s advertise the trust and price-history endpoints', async () => {
  await withServer(openConfig, fakeEngine(), async (base) => {
    const body = await (await fetch(`${base}/nope`)).json();
    assert.ok(body.error.details.availableRoutes.includes('/v1/trust'));
    assert.ok(body.error.details.availableRoutes.includes('/v1/prices/history'));
    assert.ok(body.error.details.availableRoutes.includes('/v1/flights/calendar'));
  });
});

test('/v1/flights/calendar proxies flexibleSearch with the flex parameter', async () => {
  const seen = [];
  const engine = fakeEngine({
    flexibleSearch: async (type, query, ctx, opts) => { seen.push([type, query.from, opts.flexDays]); return { type, calendar: [{ date: '2027-05-01', cheapest: { total: 210 } }], cheapestDate: '2027-05-01' }; }
  });
  await withServer(openConfig, engine, async (base) => {
    const res = await fetch(`${base}/v1/flights/calendar?from=LAX&to=JFK&date=2027-05-01&flex=2`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.data.cheapestDate, '2027-05-01');
    assert.deepEqual(seen[0], ['flights', 'LAX', '2']);
  });
});

test('POST /v1/alerts parses the JSON body and creates an alert (201)', async () => {
  const seen = [];
  const engine = fakeEngine({ createAlert: (type, body, ctx) => { seen.push([type, body.threshold, ctx.principal]); return { id: 'a1', type, threshold: body.threshold }; } });
  await withServer(openConfig, engine, async (base) => {
    const res = await fetch(`${base}/v1/alerts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'flights', from: 'LAX', to: 'JFK', date: '2027-05-01', threshold: 250 })
    });
    const body = await res.json();
    assert.equal(res.status, 201);
    assert.equal(body.data.id, 'a1');
    assert.deepEqual(seen[0], ['flights', 250, 'anonymous']);
  });
});

test('GET /v1/alerts lists and DELETE /v1/alerts?id= removes', async () => {
  const removed = [];
  const engine = fakeEngine({
    listAlerts: () => ({ alerts: [{ id: 'a1' }], count: 1 }),
    deleteAlert: (id) => { removed.push(id); return { deleted: true, id }; }
  });
  await withServer(openConfig, engine, async (base) => {
    const list = await (await fetch(`${base}/v1/alerts`)).json();
    assert.equal(list.data.count, 1);

    const del = await fetch(`${base}/v1/alerts?id=a1`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    assert.equal((await del.json()).data.deleted, true);
    assert.deepEqual(removed, ['a1']);
  });
});

test('POST /v1/alerts rejects a malformed JSON body with 400', async () => {
  await withServer(openConfig, fakeEngine(), async (base) => {
    const res = await fetch(`${base}/v1/alerts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error.message, /valid JSON/);
  });
});

test('405 Allow header reflects the methods each route accepts', async () => {
  await withServer(openConfig, fakeEngine(), async (base) => {
    const alertsPut = await fetch(`${base}/v1/alerts`, { method: 'PUT' });
    assert.equal(alertsPut.status, 405);
    assert.equal(alertsPut.headers.get('allow'), 'GET, POST, DELETE, OPTIONS');

    const searchPost = await fetch(`${base}/v1/flights/search`, { method: 'POST' });
    assert.equal(searchPost.status, 405);
    assert.equal(searchPost.headers.get('allow'), 'GET, OPTIONS');
  });
});

test('unknown-route 404s advertise the alerts endpoint', async () => {
  await withServer(openConfig, fakeEngine(), async (base) => {
    const body = await (await fetch(`${base}/nope`)).json();
    assert.ok(body.error.details.availableRoutes.includes('/v1/alerts'));
  });
});

test('/v1/flights/calendar surfaces engine validation errors', async () => {
  const engine = fakeEngine({
    flexibleSearch: async () => { const e = new Error('A center date is required for a flexible-date calendar'); e.statusCode = 400; throw e; }
  });
  await withServer(openConfig, engine, async (base) => {
    const res = await fetch(`${base}/v1/flights/calendar?from=LAX&to=JFK`);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error.message, /center date is required/);
  });
});

test('clientIp ignores X-Forwarded-For by default and uses the socket address', () => {
  assert.equal(clientIp({ headers: {}, socket: null }), 'unknown');
  // Default (no trusted proxy): a client-supplied X-Forwarded-For is ignored so
  // it cannot spoof its way around rate limiting; the socket address wins.
  assert.equal(clientIp({ headers: { 'x-forwarded-for': '198.51.100.9' }, socket: { remoteAddress: '10.0.0.5' } }), '10.0.0.5');
  assert.equal(clientIp({ headers: { 'x-forwarded-for': '198.51.100.9' }, socket: null }), 'unknown');
});

test('clientIp trusts the Nth-from-last forwarded hop when proxies are configured', () => {
  const headers = { 'x-forwarded-for': '203.0.113.7, 70.0.0.1, 10.0.0.1' };
  // One trusted proxy: the last hop is our own proxy, so the real client is the
  // second-from-last entry.
  assert.equal(clientIp({ headers, socket: { remoteAddress: '10.0.0.1' } }, 1), '10.0.0.1');
  assert.equal(clientIp({ headers, socket: { remoteAddress: '10.0.0.1' } }, 2), '70.0.0.1');
  assert.equal(clientIp({ headers, socket: { remoteAddress: '10.0.0.1' } }, 3), '203.0.113.7');
  // More hops trusted than present: fall back to the first (leftmost) entry.
  assert.equal(clientIp({ headers, socket: { remoteAddress: '10.0.0.1' } }, 9), '203.0.113.7');
  // Trusted hops set but no forwarded header: socket address.
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: '10.0.0.1' } }, 1), '10.0.0.1');
});

test('wantsHtml detects browsers and tolerates a missing Accept header', () => {
  assert.equal(wantsHtml({ headers: { accept: 'text/html,*/*' } }), true);
  assert.equal(wantsHtml({ headers: { accept: 'application/json' } }), false);
  assert.equal(wantsHtml({ headers: {} }), false); // no Accept header at all
});

test('an X-Forwarded-For client is rate-limited by its forwarded address behind a trusted proxy', async () => {
  const seen = [];
  const engine = fakeEngine({ search: async (type, query, ctx) => { seen.push(ctx.clientKey); return { query: {}, count: 0, offers: [], providers: [] }; } });
  // One trusted reverse-proxy hop, so the address our proxy wrote (the last hop)
  // is the real client and is honored.
  await withServer({ ...openConfig, trustProxyHops: 1 }, engine, async (base) => {
    const res = await fetch(`${base}/v1/flights/search?from=LAX&to=JFK`, { headers: { 'x-forwarded-for': '203.0.113.7' } });
    assert.equal(res.status, 200);
    assert.equal(seen[0], '203.0.113.7'); // the client address written by the trusted proxy
  });
});

test('an X-Forwarded-For header is ignored without a trusted proxy', async () => {
  const seen = [];
  const engine = fakeEngine({ search: async (type, query, ctx) => { seen.push(ctx.clientKey); return { query: {}, count: 0, offers: [], providers: [] }; } });
  await withServer(openConfig, engine, async (base) => {
    const res = await fetch(`${base}/v1/flights/search?from=LAX&to=JFK`, { headers: { 'x-forwarded-for': '203.0.113.7' } });
    assert.equal(res.status, 200);
    // Default config trusts no proxy: the spoofable header is ignored, the loopback
    // socket address is used as the rate-limit key.
    assert.match(seen[0], /127\.0\.0\.1|::1|::ffff:127\.0\.0\.1/);
  });
});

test('the root index advertises always-valid future example dates', async () => {
  await withServer(openConfig, fakeEngine(), async (base) => {
    const body = await (await fetch(`${base}/`)).json();
    const url = new URL(`http://x${body.data.endpoints.flights}`);
    const today = new Date().toISOString().slice(0, 10);
    // The example date must be strictly in the future so a copy-paste succeeds.
    assert.ok(url.searchParams.get('date') > today);
  });
});

test('/ready reflects engine readiness (200 vs 503)', async () => {
  await withServer(openConfig, fakeEngine({ readiness: () => ({ ok: true, providers: [] }) }), async (base) => {
    assert.equal((await fetch(`${base}/ready`)).status, 200);
  });
  await withServer(openConfig, fakeEngine({ readiness: () => ({ ok: false, providers: [] }) }), async (base) => {
    assert.equal((await fetch(`${base}/ready`)).status, 503);
  });
});

test('/metrics returns a snapshot', async () => {
  await withServer(openConfig, fakeEngine({ metricsSnapshot: () => ({ counters: { a: 1 }, timings: {} }) }), async (base) => {
    const res = await fetch(`${base}/metrics`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.data.counters.a, 1);
  });
});

test('protected /ready and /metrics require an API key when keys are configured', async () => {
  const cfg = { allowedOrigins: [], requireApiKey: false, apiKeys: ['k'] };
  await withServer(cfg, fakeEngine(), async (base) => {
    assert.equal((await fetch(`${base}/ready`)).status, 401);
    assert.equal((await fetch(`${base}/metrics`)).status, 401);
    assert.equal((await fetch(`${base}/ready`, { headers: { 'x-api-key': 'k' } })).status, 200);
    assert.equal((await fetch(`${base}/ready`, { headers: { authorization: 'Bearer k' } })).status, 200);
    assert.equal((await fetch(`${base}/ready`, { headers: { 'x-api-key': 'wrong' } })).status, 403);
  });
});

test('authenticated principal in the response never exposes raw key characters', async () => {
  const key = 'supersecretkey-abcdef123456';
  const cfg = { allowedOrigins: ['*'], requireApiKey: true, apiKeys: [key] };
  // Echo the principal back through the engine so we can inspect it.
  const engine = fakeEngine({ search: async () => ({ query: {}, count: 0, offers: [], providers: [], echoMeta: true }) });
  await withServer(cfg, engine, async (base) => {
    const res = await fetch(`${base}/v1/flights/search?from=LAX&to=JFK`, { headers: { 'x-api-key': key } });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.match(body.meta.principal, /^api-key:[0-9a-f]{12}$/);
    assert.ok(!body.meta.principal.includes('supe'));
    assert.ok(!body.meta.principal.includes('3456'));
  });
});

test('5xx responses never include internal error details', async () => {
  const leaky = fakeEngine({ search: async () => { const e = new Error('boom'); e.details = { internal: 'db dsn here' }; throw e; } });
  await withServer(openConfig, leaky, async (base) => {
    const res = await fetch(`${base}/v1/flights/search?from=LAX&to=JFK`);
    const body = await res.json();
    assert.equal(res.status, 500);
    assert.ok(!JSON.stringify(body).includes('db dsn here'));
  });
});

test('client errors surface their message, but 5xx are masked', async () => {
  const badRequest = fakeEngine({ search: async () => { const e = new Error('Missing required query parameter: to'); e.statusCode = 400; throw e; } });
  await withServer(openConfig, badRequest, async (base) => {
    const res = await fetch(`${base}/v1/flights/search?from=LAX`);
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.equal(body.error.message, 'Missing required query parameter: to');
  });

  const boom = fakeEngine({ search: async () => { throw new Error('secret internal detail'); } });
  await withServer(openConfig, boom, async (base) => {
    const res = await fetch(`${base}/v1/flights/search?from=LAX&to=JFK`);
    const body = await res.json();
    assert.equal(res.status, 500);
    assert.equal(body.error.message, 'Unexpected error');
    assert.ok(!JSON.stringify(body).includes('secret internal detail'));
  });
});

test('PWA assets are served with their content types, and 404 when absent', async () => {
  const assets = {
    '/manifest.webmanifest': '{"name":"THE Travel Club"}',
    '/sw.js': 'self.addEventListener("install", () => {});',
    '/icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>'
  };
  const withAssets = async (a, fn) => {
    const server = createServer((req, res) => handleRequest(req, res, { engine: fakeEngine(), brand, logger, config: openConfig, assets: a }));
    server.listen(0); await once(server, 'listening');
    try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); await once(server, 'close'); }
  };

  await withAssets(assets, async (base) => {
    const man = await fetch(`${base}/manifest.webmanifest`);
    assert.equal(man.status, 200);
    assert.match(man.headers.get('content-type'), /application\/manifest\+json/);
    assert.equal(man.headers.get('cache-control'), 'public, max-age=3600');
    assert.match((await man.json()).name, /Travel Club/);

    const sw = await fetch(`${base}/sw.js`);
    assert.equal(sw.status, 200);
    assert.match(sw.headers.get('content-type'), /javascript/);

    const icon = await fetch(`${base}/icon.svg`);
    assert.equal(icon.status, 200);
    assert.match(icon.headers.get('content-type'), /image\/svg/);
  });

  // Not deployed on this instance.
  await withAssets({}, async (base) => {
    assert.equal((await fetch(`${base}/sw.js`)).status, 404);
  });
});

test('search offers are signed with a lock when an offer secret is configured', async () => {
  const engine = fakeEngine({ search: async () => ({ query: {}, count: 1, offers: [{ type: 'flights', id: 'off_1', price: { total: 200, currency: 'USD' } }], providers: [] }) });
  const server = createServer((req, res) => handleRequest(req, res, { engine, brand, logger, config: openConfig, offerSecret: 'router-offer-secret' }));
  server.listen(0); await once(server, 'listening');
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const body = await (await fetch(`${base}/v1/flights/search?from=LAX&to=JFK`)).json();
    assert.ok(body.data.offers[0].lock, 'the offer carries a lock');
    assert.equal(typeof body.data.offers[0].lock.sig, 'string');
    assert.equal(typeof body.data.offers[0].lock.exp, 'number');
  } finally { server.close(); await once(server, 'close'); }
});

test('originAllowed permits same-origin, allow-listed, and header-less requests', () => {
  const cfg = { allowedOrigins: ['https://good.example'] };
  const mk = (origin) => ({ headers: { origin, host: 'h' } });
  assert.equal(originAllowed({ headers: { host: 'h' } }, cfg), true); // no Origin header
  assert.equal(originAllowed(mk('https://good.example'), cfg), true); // allow-listed
  assert.equal(originAllowed(mk('http://h'), cfg), true); // same-origin (host matches)
  assert.equal(originAllowed(mk('https://evil.example'), cfg), false); // cross-origin
  assert.equal(originAllowed(mk(':::://bad'), cfg), false); // malformed Origin -> catch
  assert.equal(originAllowed(mk('https://anything'), { allowedOrigins: ['*'] }), true); // wildcard
  assert.equal(originAllowed(mk('https://x'), {}), false); // no allowedOrigins, not same-origin
});

test('a cross-origin mutating request carrying a session cookie is blocked (CSRF guard)', async () => {
  const cfg = { allowedOrigins: ['https://good.example'], requireApiKey: false, apiKeys: [] };
  await withServer(cfg, fakeEngine(), async (base) => {
    const u = new URL(base);
    const post = (headers) => new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: u.hostname, port: u.port, path: '/v1/alerts', method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end('{"type":"flights"}');
    });
    // Session cookie + cross-origin -> 403.
    assert.equal(await post({ cookie: 'tc_session=x', origin: 'https://evil.example' }), 403);
    // Session cookie + allow-listed origin -> passes the CSRF guard.
    assert.notEqual(await post({ cookie: 'tc_session=x', origin: 'https://good.example' }), 403);
    // No session cookie -> guard does not apply, even cross-origin.
    assert.notEqual(await post({ origin: 'https://evil.example' }), 403);
  });
});

test('the app page CSP allows the manifest and the service worker', async () => {
  await withServer(openConfig, fakeEngine(), async (base) => {
    const res = await fetch(`${base}/app`);
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /manifest-src 'self'/);
    assert.match(csp, /worker-src 'self'/);
  }, null, samplePages);
});

test('health is public and includes a request id from the client when provided', async () => {
  await withServer(openConfig, fakeEngine(), async (base) => {
    const res = await fetch(`${base}/health`, { headers: { 'x-request-id': 'req-123' } });
    assert.equal(res.headers.get('x-request-id'), 'req-123');
    const body = await res.json();
    assert.equal(body.data.ok, true);
  });
});
