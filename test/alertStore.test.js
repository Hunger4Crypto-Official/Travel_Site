import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AlertStore } from '../src/utils/alertStore.js';

// Deterministic id/clock helpers so nothing depends on real time or randomness.
function counterId() {
  let n = 0;
  return () => `id-${(n += 1)}`;
}

test('create fills defaults and stamps id/createdAt from injected factory and clock', () => {
  const store = new AlertStore({ now: () => 111, idFactory: counterId() });
  const watch = store.create({ type: 'flights', query: { from: 'LAX' }, key: 'LAX-JFK' });
  assert.deepEqual(watch, {
    id: 'id-1',
    owner: 'anonymous',
    type: 'flights',
    query: { from: 'LAX' },
    key: 'LAX-JFK',
    threshold: null,
    currency: null,
    notifyUrl: null,
    createdAt: 111,
    active: true,
    lastPrice: null,
    triggered: false,
    lastTriggeredAt: null,
    lastCheckedAt: null
  });
  assert.equal(store.get('id-1'), watch);
});

test('create normalizes owner, threshold, currency, notifyUrl and opaque fields', () => {
  const store = new AlertStore({ now: () => 5, idFactory: counterId() });
  const withThreshold = store.create({
    type: 'hotels',
    owner: 'alice',
    threshold: 250,
    currency: 'USD',
    notifyUrl: 'https://example.test/hook'
  });
  assert.equal(withThreshold.owner, 'alice');
  assert.equal(withThreshold.threshold, 250);
  assert.equal(withThreshold.currency, 'USD');
  assert.equal(withThreshold.notifyUrl, 'https://example.test/hook');

  // Non-string / non-object inputs fall back to their defaults.
  const coerced = store.create({ type: 'cars', owner: 42, query: 'nope', key: 7, currency: 9, notifyUrl: {}, threshold: null });
  assert.equal(coerced.owner, 'anonymous');
  assert.deepEqual(coerced.query, {});
  assert.equal(coerced.key, null);
  assert.equal(coerced.currency, null);
  assert.equal(coerced.notifyUrl, null);
  assert.equal(coerced.threshold, null);
});

test('create rejects an invalid type with a 400', () => {
  const store = new AlertStore({ idFactory: counterId() });
  assert.throws(
    () => store.create({ type: 'trains' }),
    (err) => err.statusCode === 400 && /flights/.test(err.message)
  );
  assert.throws(() => store.create(), (err) => err.statusCode === 400); // zero-arg default input
});

test('create rejects a non-finite or negative threshold with a 400', () => {
  const store = new AlertStore({ idFactory: counterId() });
  assert.throws(() => store.create({ type: 'flights', threshold: Infinity }), (err) => err.statusCode === 400);
  assert.throws(() => store.create({ type: 'flights', threshold: -1 }), (err) => err.statusCode === 400);
});

test('list is owner-scoped and most-recent-first; get misses return null', () => {
  let clock = 0;
  const store = new AlertStore({ now: () => (clock += 1), idFactory: counterId() });
  const a1 = store.create({ type: 'flights', owner: 'a' });
  const b1 = store.create({ type: 'hotels', owner: 'b' });
  const a2 = store.create({ type: 'cars', owner: 'a' });

  assert.deepEqual(store.list('a').map((w) => w.id), [a2.id, a1.id]);
  assert.deepEqual(store.list('b').map((w) => w.id), [b1.id]);
  assert.deepEqual(store.list('nobody'), []);
  assert.equal(store.get('missing'), null);
});

test('remove only deletes an owned watch', () => {
  const store = new AlertStore({ now: () => 1, idFactory: counterId() });
  const watch = store.create({ type: 'flights', owner: 'alice' });
  assert.equal(store.remove(watch.id, 'bob'), false); // wrong owner
  assert.equal(store.remove('missing', 'alice'), false); // no such watch
  assert.ok(store.get(watch.id)); // still present
  assert.equal(store.remove(watch.id, 'alice'), true);
  assert.equal(store.get(watch.id), null);
});

test('update shallow-merges into an existing watch and returns null when missing', () => {
  const store = new AlertStore({ now: () => 1, idFactory: counterId() });
  const watch = store.create({ type: 'flights' });
  const updated = store.update(watch.id, { lastPrice: 99, triggered: true, lastTriggeredAt: 7, lastCheckedAt: 8 });
  assert.equal(updated.lastPrice, 99);
  assert.equal(updated.triggered, true);
  assert.equal(updated.lastTriggeredAt, 7);
  assert.equal(updated.lastCheckedAt, 8);
  assert.equal(store.get(watch.id).lastPrice, 99);
  assert.equal(store.update('missing', { lastPrice: 1 }), null);
  assert.equal(store.update('missing'), null); // zero-patch default path
});

test('maxEntries evicts the oldest by createdAt', () => {
  let clock = 100;
  const store = new AlertStore({ maxEntries: 2, now: () => (clock += 1), idFactory: counterId() });
  const first = store.create({ type: 'flights' });
  const second = store.create({ type: 'hotels' });
  const third = store.create({ type: 'cars' });
  assert.equal(store.get(first.id), null); // oldest evicted
  assert.ok(store.get(second.id));
  assert.ok(store.get(third.id));
  assert.equal(store.watches.size, 2);
});

test('activeWatches returns every watch that is not explicitly inactive, across owners', () => {
  const store = new AlertStore({ now: () => 1, idFactory: counterId() });
  const a = store.create({ type: 'flights', owner: 'a' });
  const b = store.create({ type: 'hotels', owner: 'b' });
  store.update(b.id, { active: false });
  const ids = store.activeWatches().map((w) => w.id);
  assert.deepEqual(ids, [a.id]);
});

test('persists to JSONL and reloads across owners', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alert-store-'));
  const file = join(dir, 'watches.jsonl');
  const store = new AlertStore({ filePath: file, now: () => 42, idFactory: counterId() });
  store.create({ type: 'flights', owner: 'a', threshold: 100 });
  store.create({ type: 'hotels', owner: 'b' });
  assert.equal(store.lastPersistError, null);
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 2);

  const reloaded = new AlertStore({ filePath: file, now: () => 99, idFactory: counterId() });
  assert.equal(reloaded.list('a').length, 1);
  assert.equal(reloaded.list('a')[0].threshold, 100);
  assert.equal(reloaded.list('b').length, 1);
});

test('reload skips malformed and id-less lines, and trims to maxEntries by createdAt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alert-store-'));
  const file = join(dir, 'watches.jsonl');
  const good = [1, 2, 3].map((createdAt) => JSON.stringify({ id: `w${createdAt}`, owner: 'a', type: 'cars', createdAt, active: true }));
  // Two stampless rows so the sort comparator exercises the createdAt fallback on both sides.
  const noStamp = ['w0a', 'w0b'].map((id) => JSON.stringify({ id, owner: 'a', type: 'cars', active: true }));
  writeFileSync(file, `${good.join('\n')}\n${noStamp.join('\n')}\nnot json\n{"noId":true}\nnull\n\n`);

  const store = new AlertStore({ filePath: file, maxEntries: 2, now: () => 1, idFactory: counterId() });
  assert.deepEqual(store.list('a').map((w) => w.id), ['w3', 'w2']); // newest two kept, most-recent-first
  assert.equal(store.watches.size, 2);
});

test('a missing file is a no-op and an absent filePath skips persistence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alert-store-'));
  const missing = new AlertStore({ filePath: join(dir, 'nope.jsonl'), idFactory: counterId() });
  assert.equal(missing.watches.size, 0);

  const inMemory = new AlertStore({ idFactory: counterId() });
  inMemory.create({ type: 'flights' });
  assert.equal(inMemory.lastPersistError, null); // no filePath, nothing to persist
});

test('persist rewrites an empty file when the last watch is removed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alert-store-'));
  const file = join(dir, 'watches.jsonl');
  const store = new AlertStore({ filePath: file, now: () => 1, idFactory: counterId() });
  const watch = store.create({ type: 'flights', owner: 'a' });
  store.remove(watch.id, 'a');
  assert.equal(readFileSync(file, 'utf8'), '');
});

test('a failing persist path still mutates in memory and records lastPersistError', () => {
  const store = new AlertStore({ filePath: '/nonexistent-dir/deep/watches.jsonl', now: () => 1, idFactory: counterId() });
  const watch = store.create({ type: 'cars', owner: 'a' });
  assert.ok(store.get(watch.id)); // create succeeded in memory
  assert.ok(store.lastPersistError); // and the failure is observable
});

test('the default idFactory produces unique ids', () => {
  const store = new AlertStore(); // zero-arg construction exercises every default
  assert.equal(store.watches.size, 0);
  const a = store.create({ type: 'flights' });
  const b = store.create({ type: 'flights' });
  assert.notEqual(a.id, b.id);
  assert.equal(typeof a.id, 'string');
});
