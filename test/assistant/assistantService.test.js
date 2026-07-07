import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AssistantService, sanitize, extractJson } from '../../src/assistant/assistantService.js';

function fakeClient(over = {}) {
  return {
    enabled: over.enabled ?? true,
    model: over.model || 'llama3.2',
    generate: over.generate || (async () => '{"type":"flights","from":"lax","to":"jfk","date":"2027-05-01"}')
  };
}

test('status reflects the client', () => {
  const s = new AssistantService({ client: fakeClient({ model: 'mistral' }) });
  assert.deepEqual(s.status(), { enabled: true, model: 'mistral' });
});

test('parseSearch returns a sanitized suggestion and a disclaimer', async () => {
  const seen = [];
  const s = new AssistantService({ client: fakeClient({ generate: async (p, o) => { seen.push({ p, o }); return '{"type":"flights","from":"lax","to":"jfk","date":"2027-05-01","price":500,"junk":"x"}'; } }) });
  const out = await s.parseSearch('cheap flight from LA to New York on May 1 2027');
  assert.deepEqual(out.suggestion, { type: 'flights', from: 'LAX', to: 'JFK', date: '2027-05-01' });
  assert.equal(out.suggestion.price, undefined, 'a price from the model is never passed through');
  assert.match(out.disclaimer, /suggestion from a local AI/i);
  assert.equal(seen[0].o.format, 'json');
  assert.match(seen[0].p, /New York/);
});

test('parseSearch rejects empty and overlong input', async () => {
  const s = new AssistantService({ client: fakeClient() });
  await assert.rejects(() => s.parseSearch(''), (e) => e.statusCode === 400);
  await assert.rejects(() => s.parseSearch('   '), (e) => e.statusCode === 400);
  await assert.rejects(() => s.parseSearch(123), (e) => e.statusCode === 400);
  await assert.rejects(() => s.parseSearch('x'.repeat(401)), (e) => e.statusCode === 400);
});

test('parseSearch surfaces a model-unavailable error', async () => {
  const s = new AssistantService({ client: fakeClient({ generate: async () => { const e = new Error('The assistant is unavailable right now. Please try again.'); e.statusCode = 502; throw e; } }) });
  await assert.rejects(() => s.parseSearch('a flight'), (e) => e.statusCode === 502);
});

test('sanitize keeps only whitelisted, well-formed fields', () => {
  assert.deepEqual(sanitize(null), {});
  assert.deepEqual(sanitize('nope'), {});
  assert.deepEqual(
    sanitize({ type: 'flights', from: 'lax', to: 'jf', date: '2027-05-01', checkin: 'bad', city: '  Las Vegas  ', junk: 1, price: 200 }),
    { type: 'flights', from: 'LAX', date: '2027-05-01', city: 'Las Vegas' }
  );
  assert.deepEqual(
    sanitize({ type: 'trains', from: 'klax', to: 'JFK', checkout: '2027-05-05' }),
    { from: 'KLAX', to: 'JFK', checkout: '2027-05-05' }
  );
  assert.deepEqual(sanitize({ type: 123, city: '   ', checkin: '2027-06-01' }), { checkin: '2027-06-01' });
});

test('extractJson tolerates stray text and never throws', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('sure! {"type":"hotels"} done'), { type: 'hotels' });
  assert.deepEqual(extractJson('no json here'), {});
  assert.deepEqual(extractJson('{broken json'), {}); // no closing brace
  assert.deepEqual(extractJson('pre {still broken} post'), {}); // brace slice still invalid
  assert.deepEqual(extractJson(123), {}); // non-string
});
