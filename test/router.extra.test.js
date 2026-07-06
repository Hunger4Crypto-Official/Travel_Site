import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { brand } from '../src/config/brand.js';
import { handleRequest, clientIp } from '../src/routes/router.js';

const logger = { info() {}, warn() {}, error() {}, debug() {} };

// A configurable fake engine so we can drive every router branch deterministically.
function fakeEngine(overrides = {}) {
  return {
    search: overrides.search || (async () => ({ query: {}, count: 0, offers: [], providers: [] })),
    readiness: overrides.readiness || (() => ({ ok: true, providers: [] })),
    metricsSnapshot: overrides.metricsSnapshot || (() => ({ counters: {}, timings: {} })),
    priceHistorySnapshot: overrides.priceHistorySnapshot || (() => ({ type: 'flights', key: 'LAX-JFK', samples: 0 }))
  };
}

async function withServer(config, engine, fn, openapiSpec = null) {
  const server = createServer((req, res) => handleRequest(req, res, { engine, brand, logger, config, openapiSpec }));
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

test('/v1/trust is public, cacheable, and lists the published commitments', async () => {
  const cfg = { allowedOrigins: ['*'], requireApiKey: true, apiKeys: ['k'] }; // auth required for search...
  await withServer(cfg, fakeEngine(), async (base) => {
    const res = await fetch(`${base}/v1/trust`); // ...but the manifest needs no key
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=300');
    const ids = body.data.commitments.map((c) => c.id);
    assert.deepEqual(ids, ['all-in-pricing', 'no-fake-urgency', 'no-paid-ranking', 'freshness-disclosure', 'honest-failures', 'price-context']);
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
  });
});

test('clientIp falls back to "unknown" without a forwarded header or socket', () => {
  assert.equal(clientIp({ headers: {}, socket: null }), 'unknown');
  assert.equal(clientIp({ headers: { 'x-forwarded-for': '198.51.100.9' }, socket: null }), '198.51.100.9');
});

test('an X-Forwarded-For client is rate-limited by its forwarded address', async () => {
  const seen = [];
  const engine = fakeEngine({ search: async (type, query, ctx) => { seen.push(ctx.clientKey); return { query: {}, count: 0, offers: [], providers: [] }; } });
  await withServer(openConfig, engine, async (base) => {
    const res = await fetch(`${base}/v1/flights/search?from=LAX&to=JFK`, { headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' } });
    assert.equal(res.status, 200);
    assert.equal(seen[0], '203.0.113.7'); // first hop wins, not the socket address
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

test('health is public and includes a request id from the client when provided', async () => {
  await withServer(openConfig, fakeEngine(), async (base) => {
    const res = await fetch(`${base}/health`, { headers: { 'x-request-id': 'req-123' } });
    assert.equal(res.headers.get('x-request-id'), 'req-123');
    const body = await res.json();
    assert.equal(body.data.ok, true);
  });
});
