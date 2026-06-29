import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { brand } from '../src/config/brand.js';
import { TravelEngine } from '../src/engine/travelEngine.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { handleRequest } from '../src/routes/router.js';

const config = {
  allowedOrigins: ['https://app.example.com'],
  requireApiKey: true,
  apiKeys: ['test-key']
};

async function withServer(fn) {
  const engine = new TravelEngine({ providers: [new MockProvider({ name: 'demo' })] });
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
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

test('public health does not require an API key and includes request id', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`, { headers: { origin: 'https://app.example.com' } });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://app.example.com');
    assert.equal(Boolean(response.headers.get('x-request-id')), true);
    assert.equal(body.data.ok, true);
  });
});

test('protected search requires API key', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/flights/search?from=LAX&to=JFK`);
    const body = await response.json();

    assert.equal(response.status, 401);
    assert.equal(body.error.message, 'Authentication required');
  });
});

test('versioned flight search succeeds with API key', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/flights/search?from=LAX&to=JFK`, { headers: { 'x-api-key': 'test-key' } });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.status, 'success');
    assert.equal(body.data.count, 3);
  });
});

test('unsupported methods and unknown routes return structured errors', async () => {
  await withServer(async (baseUrl) => {
    const postResponse = await fetch(`${baseUrl}/health`, { method: 'POST' });
    const missingResponse = await fetch(`${baseUrl}/missing`, { headers: { 'x-api-key': 'test-key' } });

    assert.equal(postResponse.status, 405);
    assert.equal(missingResponse.status, 404);
  });
});
