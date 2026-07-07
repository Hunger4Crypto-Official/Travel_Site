import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrderStore } from '../../src/booking/orderStore.js';

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'orders-'));
  return { path: join(dir, 'orders.jsonl'), dir };
}
function seq() { let n = 0; return () => `o${++n}`; }

test('create stamps id and timestamps; get hits and misses', () => {
  const store = new OrderStore({ now: () => 1000, idFactory: seq() });
  const order = store.create({ owner: 'user:1', type: 'flights', status: 'confirmed' });
  assert.equal(order.id, 'o1');
  assert.equal(order.createdAt, 1000);
  assert.equal(order.updatedAt, 1000);
  assert.equal(store.get('o1').owner, 'user:1');
  assert.equal(store.get('missing'), null);
  assert.equal(store.count(), 1);
});

test('list is owner-scoped and most-recent-first', () => {
  let clock = 0;
  const store = new OrderStore({ now: () => ++clock, idFactory: seq() });
  store.create({ owner: 'a', type: 'flights' });
  store.create({ owner: 'b', type: 'hotels' });
  const a2 = store.create({ owner: 'a', type: 'cars' });
  const listed = store.list('a');
  assert.equal(listed.length, 2);
  assert.equal(listed[0].id, a2.id, 'newest first');
  assert.deepEqual(store.list('nobody'), []);
});

test('update patches and keeps id/createdAt immutable', () => {
  let clock = 5;
  const store = new OrderStore({ now: () => clock, idFactory: seq() });
  const order = store.create({ owner: 'a', type: 'flights', status: 'confirmed' });
  clock = 9;
  const updated = store.update(order.id, { status: 'cancelled', id: 'hax', createdAt: 0 });
  assert.equal(updated.status, 'cancelled');
  assert.equal(updated.id, order.id);
  assert.equal(updated.createdAt, 5);
  assert.equal(updated.updatedAt, 9);
  assert.equal(store.update('nope', { status: 'x' }), null);
});

test('maxEntries evicts the oldest on create', () => {
  let clock = 0;
  const store = new OrderStore({ maxEntries: 2, now: () => ++clock, idFactory: seq() });
  const first = store.create({ owner: 'a', type: 'flights' });
  store.create({ owner: 'a', type: 'hotels' });
  store.create({ owner: 'a', type: 'cars' });
  assert.equal(store.count(), 2);
  assert.equal(store.get(first.id), null, 'the oldest order was evicted');
});

test('persists to JSONL, reloads, caps and skips corruption', () => {
  const { path } = tmp();
  const store = new OrderStore({ filePath: path, now: () => 1, idFactory: seq() });
  store.create({ owner: 'a', type: 'flights', status: 'confirmed' });
  assert.ok(readFileSync(path, 'utf8').includes('confirmed'));

  const reloaded = new OrderStore({ filePath: path });
  assert.equal(reloaded.count(), 1);

  writeFileSync(path, [
    'not json',
    JSON.stringify({ noId: true }),
    JSON.stringify({ id: 'k1', owner: 'a', type: 'flights', createdAt: 3 }),
    JSON.stringify({ id: 'k2', owner: 'a', type: 'hotels', createdAt: 1 })
  ].join('\n'));
  const capped = new OrderStore({ filePath: path, maxEntries: 1 });
  assert.equal(capped.count(), 1);
  assert.ok(capped.get('k1'), 'the most recent record is kept');
  assert.equal(capped.get('k2'), null);
});

test('load tolerates records without a createdAt when sorting', () => {
  const { path } = tmp();
  writeFileSync(path, [
    JSON.stringify({ id: 'a', owner: 'x', type: 'flights' }),
    JSON.stringify({ id: 'b', owner: 'x', type: 'hotels' })
  ].join('\n'));
  assert.equal(new OrderStore({ filePath: path }).count(), 2);
});

test('load is a no-op for a missing file and tolerates an unreadable path', () => {
  const { path, dir } = tmp();
  assert.equal(new OrderStore({ filePath: join(path, 'nope.jsonl') }).count(), 0);
  const store = new OrderStore({ filePath: dir }); // a directory: readFileSync throws
  assert.ok(store.lastPersistError);
  assert.equal(store.count(), 0);
  rmSync(dir, { recursive: true, force: true });
});

test('persist writes empty and records a failure without throwing', () => {
  const { path } = tmp();
  const empty = new OrderStore({ filePath: path });
  empty.persist();
  assert.equal(readFileSync(path, 'utf8'), '');

  const { dir } = tmp();
  const store = new OrderStore({ filePath: dir, idFactory: seq() });
  store.create({ owner: 'a', type: 'flights' });
  assert.ok(store.lastPersistError);
  assert.equal(store.count(), 1);
  rmSync(dir, { recursive: true, force: true });
});
