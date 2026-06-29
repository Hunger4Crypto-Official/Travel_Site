import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { brand } from '../src/config/brand.js';
import { handleRequest } from '../src/routes/router.js';

const logger = { info() {}, warn() {}, error() {}, debug() {} };

// A configurable fake engine so we can drive every router branch deterministically.
function fakeEngine(overrides = {}) {
  return {
    search: overrides.search || (async () => ({ query: {}, count: 0, offers: [], providers: [] })),
    readiness: overrides.readiness || (() => ({ ok: true, providers: [] })),
    metricsSnapshot: overrides.metricsSnapshot || (() => ({ counters: {}, timings: {} }))
  };
}

async function withServer(config, engine, fn) {
  const server = createServer((req, res) => handleRequest(req, res, { engine, brand, logger, config }));
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

test('OPTIONS preflight returns 204 and CORS wildcard echoes origin', async () => {
  await withServer(openConfig, fakeEngine(), async (base) => {
    const res = await fetch(`${base}/v1/flights/search`, { method: 'OPTIONS', headers: { origin: 'https://any.example' } });
    assert.equal(res.status, 204);
    // Wildcard config emits a literal '*' rather than reflecting the origin.
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  });
});

test('non-GET methods are rejected with 405', async () => {
  await withServer(openConfig, fakeEngine(), async (base) => {
    const res = await fetch(`${base}/v1/flights/search`, { method: 'POST' });
    assert.equal(res.status, 405);
  });
});

test('unknown routes return a structured 404', async () => {
  await withServer(openConfig, fakeEngine(), async (base) => {
    const res = await fetch(`${base}/nope`);
    const body = await res.json();
    assert.equal(res.status, 404);
    assert.equal(body.error.statusCode, 404);
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
