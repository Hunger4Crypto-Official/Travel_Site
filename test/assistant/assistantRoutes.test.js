import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { brand } from '../../src/config/brand.js';
import { handleRequest } from '../../src/routes/router.js';
import { AssistantService } from '../../src/assistant/assistantService.js';
import { createAssistantService } from '../../src/assistant/index.js';
import { KeyedRateLimiter } from '../../src/utils/rateLimit.js';

const logger = { info() {}, warn() {}, error() {}, debug() {} };
const engine = {
  search: async () => ({}), flexibleSearch: async () => ({}), readiness: () => ({ ok: true }),
  metricsSnapshot: () => ({}), priceHistorySnapshot: () => ({}), createAlert: () => ({}), listAlerts: () => ({}), deleteAlert: () => ({})
};
const config = { allowedOrigins: ['*'], requireApiKey: false, apiKeys: [] };

function fakeClient(over = {}) {
  return { enabled: true, model: 'llama3.2', generate: over.generate || (async () => '{"type":"flights","from":"lax","to":"jfk"}') };
}

async function withServer(assistantService, fn, writeLimiter = null) {
  const server = createServer((req, res) => handleRequest(req, res, { engine, brand, logger, config, assistantService, writeLimiter }));
  server.listen(0); await once(server, 'listening');
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); await once(server, 'close'); }
}

test('GET /v1/assistant reports status and POST /v1/assistant/parse suggests a query', async () => {
  await withServer(new AssistantService({ client: fakeClient() }), async (base) => {
    const status = await (await fetch(`${base}/v1/assistant`)).json();
    assert.equal(status.data.enabled, true);
    assert.equal(status.data.model, 'llama3.2');

    const res = await fetch(`${base}/v1/assistant/parse`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'flight from LA to New York' }) });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(body.data.suggestion, { type: 'flights', from: 'LAX', to: 'JFK' });
    assert.ok(body.data.disclaimer);
  });
});

test('bad input is 400 and a model outage surfaces as 502', async () => {
  await withServer(new AssistantService({ client: fakeClient() }), async (base) => {
    const bad = await fetch(`${base}/v1/assistant/parse`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '' }) });
    assert.equal(bad.status, 400);
  });
  const down = new AssistantService({ client: fakeClient({ generate: async () => { const e = new Error('The assistant is unavailable right now. Please try again.'); e.statusCode = 502; throw e; } }) });
  await withServer(down, async (base) => {
    const res = await fetch(`${base}/v1/assistant/parse`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'a flight' }) });
    assert.equal(res.status, 502);
    assert.match((await res.json()).error.message, /unavailable/);
  });
});

test('assistant requests are rate-limited', async () => {
  const writeLimiter = new KeyedRateLimiter({ capacity: 1, refillPerMinute: 1 });
  await withServer(new AssistantService({ client: fakeClient() }), async (base) => {
    assert.equal((await fetch(`${base}/v1/assistant`)).status, 200);
    const second = await fetch(`${base}/v1/assistant`);
    assert.equal(second.status, 429);
    assert.ok(second.headers.get('retry-after'));
  }, writeLimiter);
});

test('an internal assistant error with no status code is masked as 500', async () => {
  const broken = new AssistantService({ client: fakeClient({ generate: async () => { throw new Error('kaboom'); } }) });
  await withServer(broken, async (base) => {
    const res = await fetch(`${base}/v1/assistant/parse`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'a flight' }) });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error.message, 'Unexpected error');
  });
});

test('assistant routes 404 when disabled, and the method gate is POST-only for parse', async () => {
  await withServer(null, async (base) => {
    assert.equal((await fetch(`${base}/v1/assistant`)).status, 404);
    assert.equal((await fetch(`${base}/v1/assistant/parse`, { method: 'POST', body: '{}' })).status, 404);
  });
  await withServer(new AssistantService({ client: fakeClient() }), async (base) => {
    const get = await fetch(`${base}/v1/assistant/parse`);
    assert.equal(get.status, 405);
    assert.equal(get.headers.get('allow'), 'POST, OPTIONS');
    const index = await (await fetch(`${base}/`, { headers: { accept: 'application/json' } })).json();
    assert.equal(index.data.endpoints.assistant, '/v1/assistant');
  });
});

test('createAssistantService is null when disabled and live via the injected fetch', async () => {
  assert.equal(createAssistantService({ assistantEnabled: false }), null);
  const captured = [];
  const fakeFetch = async (url, opts) => { captured.push({ url, opts }); return { response: '{"type":"cars","city":"Miami"}' }; };
  const svc = createAssistantService({ assistantEnabled: true, ollamaUrl: 'http://ollama:11434', ollamaModel: 'llama3.2' }, { fetchJson: fakeFetch });
  const out = await svc.parseSearch('rent a car in Miami');
  assert.deepEqual(out.suggestion, { type: 'cars', city: 'Miami' });
  assert.match(captured[0].url, /\/api\/generate$/);
  assert.equal(typeof captured[0].opts.body, 'string');
});
