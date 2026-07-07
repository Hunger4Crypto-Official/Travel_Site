import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createOllamaClient } from '../../src/assistant/ollamaClient.js';

// A fake fetchJson that records the last call and returns a canned reply.
function makeFetch(reply) {
  const calls = [];
  const fetchJson = async (url, options) => {
    calls.push({ url, options });
    if (typeof reply === 'function') return reply();
    return reply;
  };
  return { fetchJson, calls };
}

test('exposes enabled/model/baseUrl and trims a single trailing slash', () => {
  const { fetchJson } = makeFetch({ response: 'ok' });
  const client = createOllamaClient({ baseUrl: 'http://h:11434/', model: 'm', enabled: true, fetchJson });
  assert.equal(client.enabled, true);
  assert.equal(client.model, 'm');
  assert.equal(client.baseUrl, 'http://h:11434');
});

test('enabled defaults to false and is coerced to a boolean', () => {
  const { fetchJson } = makeFetch({ response: 'ok' });
  const client = createOllamaClient({ fetchJson });
  assert.equal(client.enabled, false);
});

test('generate posts to the correct URL and returns the trimmed response', async () => {
  const { fetchJson, calls } = makeFetch({ response: '  hello world  ' });
  const client = createOllamaClient({ baseUrl: 'http://h:11434/', model: 'm', fetchJson });

  const out = await client.generate('say hi');
  assert.equal(out, 'hello world');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://h:11434/api/generate');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].options.timeoutMs, 20000);

  // Body is a JSON string containing the model and prompt, no format by default.
  assert.equal(typeof calls[0].options.body, 'string');
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body, { model: 'm', prompt: 'say hi', stream: false });
});

test('generate with { format: "json" } includes format in the stringified body', async () => {
  const { fetchJson, calls } = makeFetch({ response: '{}' });
  const client = createOllamaClient({ model: 'm', fetchJson });

  await client.generate('parse this', { format: 'json' });
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.format, 'json');
});

test('generate rejects an empty prompt with a 400', async () => {
  const { fetchJson } = makeFetch({ response: 'ok' });
  const client = createOllamaClient({ fetchJson });
  await assert.rejects(() => client.generate('   '), (err) => {
    assert.equal(err.statusCode, 400);
    assert.equal(err.message, 'A prompt is required');
    return true;
  });
});

test('generate rejects a non-string prompt with a 400', async () => {
  const { fetchJson } = makeFetch({ response: 'ok' });
  const client = createOllamaClient({ fetchJson });
  await assert.rejects(() => client.generate(42), (err) => {
    assert.equal(err.statusCode, 400);
    return true;
  });
});

test('generate throws a 502 when data.response is not a string', async () => {
  const { fetchJson } = makeFetch({ response: 123 });
  const client = createOllamaClient({ fetchJson });
  await assert.rejects(() => client.generate('hi'), (err) => {
    assert.equal(err.statusCode, 502);
    assert.equal(err.message, 'The assistant returned an unexpected response.');
    return true;
  });
});

test('generate wraps a rejecting fetchJson into a 502 with .cause set', async () => {
  const boom = new Error('socket hang up');
  const { fetchJson } = makeFetch(() => { throw boom; });
  const client = createOllamaClient({ fetchJson });
  await assert.rejects(() => client.generate('hi'), (err) => {
    assert.equal(err.statusCode, 502);
    assert.equal(err.message, 'The assistant is unavailable right now. Please try again.');
    assert.equal(err.cause, boom);
    return true;
  });
});
