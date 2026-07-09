import test from 'node:test';
import assert from 'node:assert/strict';
import { IdempotencyStore } from '../src/utils/idempotencyStore.js';

test('keyFor is deterministic for identical inputs', () => {
  const store = new IdempotencyStore();
  const a = store.keyFor('user-1', 'POST', '/bookings', 'idem-abc');
  const b = store.keyFor('user-1', 'POST', '/bookings', 'idem-abc');
  assert.equal(a, b);
  assert.equal(typeof a, 'string');
});

test('keyFor yields different keys for different inputs', () => {
  const store = new IdempotencyStore();
  const base = store.keyFor('user-1', 'POST', '/bookings', 'idem-abc');
  assert.notEqual(base, store.keyFor('user-2', 'POST', '/bookings', 'idem-abc'));
  assert.notEqual(base, store.keyFor('user-1', 'GET', '/bookings', 'idem-abc'));
  assert.notEqual(base, store.keyFor('user-1', 'POST', '/orders', 'idem-abc'));
  assert.notEqual(base, store.keyFor('user-1', 'POST', '/bookings', 'idem-xyz'));
});

test('keyFor length-prefixing prevents boundary collisions', () => {
  const store = new IdempotencyStore();
  assert.notEqual(
    store.keyFor('a', 'bc', 'd', 'e'),
    store.keyFor('ab', 'c', 'd', 'e'),
  );
});

test('keyFor coerces nullish parts without throwing', () => {
  const store = new IdempotencyStore();
  const withNulls = store.keyFor(null, undefined, '/p', 'k');
  const withEmpties = store.keyFor('', '', '/p', 'k');
  assert.equal(typeof withNulls, 'string');
  // null/undefined both coerce to empty, matching explicit empty strings.
  assert.equal(withNulls, withEmpties);
});

test('get returns null on a miss', () => {
  const store = new IdempotencyStore();
  assert.equal(store.get('nope'), null);
});

test('put then get returns the stored statusCode and body', () => {
  const store = new IdempotencyStore();
  const key = store.keyFor('user-1', 'POST', '/bookings', 'idem-1');
  store.put(key, 201, { id: 'order-1' });
  assert.deepEqual(store.get(key), { statusCode: 201, body: { id: 'order-1' } });
});

test('get removes and returns null for an expired entry', () => {
  let clock = 1000;
  const store = new IdempotencyStore({ ttlMs: 500, now: () => clock });
  const key = 'k';
  store.put(key, 200, 'ok');
  clock = 1000 + 500; // createdAt + ttlMs === now -> expired boundary.
  assert.equal(store.get(key), null);
  assert.equal(store.byKey.has(key), false);
});

test('get returns the entry just before expiry', () => {
  let clock = 0;
  const store = new IdempotencyStore({ ttlMs: 500, now: () => clock });
  store.put('k', 204, null);
  clock = 499;
  assert.deepEqual(store.get('k'), { statusCode: 204, body: null });
});

test('put evicts the oldest entry past maxEntries', () => {
  let clock = 0;
  const store = new IdempotencyStore({ maxEntries: 2, now: () => clock });
  clock = 10;
  store.put('a', 200, 'a');
  clock = 20;
  store.put('b', 200, 'b');
  clock = 30;
  store.put('c', 200, 'c');
  assert.equal(store.get('a'), null);
  assert.deepEqual(store.get('b'), { statusCode: 200, body: 'b' });
  assert.deepEqual(store.get('c'), { statusCode: 200, body: 'c' });
});

test('put overwrites an existing key', () => {
  let clock = 0;
  const store = new IdempotencyStore({ now: () => clock });
  store.put('k', 200, 'first');
  clock = 5;
  store.put('k', 409, 'second');
  assert.deepEqual(store.get('k'), { statusCode: 409, body: 'second' });
  assert.equal(store.byKey.size, 1);
});

test('evictOldest is a no-op on an empty store', () => {
  const store = new IdempotencyStore();
  store.evictOldest();
  assert.equal(store.byKey.size, 0);
});

test('default constructor options are applied', () => {
  const store = new IdempotencyStore();
  assert.equal(store.ttlMs, 86400000);
  assert.equal(store.maxEntries, 10000);
  assert.equal(typeof store.now(), 'number');
});
