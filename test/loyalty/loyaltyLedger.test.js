import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoyaltyLedger } from '../../src/loyalty/loyaltyLedger.js';

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'loyalty-'));
  return { path: join(dir, 'ledger.jsonl'), dir };
}
function seq() { let n = 0; return () => `t${++n}`; }

test('record returns a stamped transaction and count grows', () => {
  const ledger = new LoyaltyLedger({ now: () => 1000, idFactory: seq() });
  const txn = ledger.record({ owner: 'user:1', type: 'earn', points: 50, reason: 'signup', orderId: 'ord1', balanceAfter: 50 });
  assert.equal(txn.id, 't1');
  assert.equal(txn.owner, 'user:1');
  assert.equal(txn.type, 'earn');
  assert.equal(txn.points, 50);
  assert.equal(txn.reason, 'signup');
  assert.equal(txn.orderId, 'ord1');
  assert.equal(txn.balanceAfter, 50);
  assert.equal(txn.createdAt, 1000);
  assert.equal(ledger.count(), 1);

  const defaults = ledger.record({ owner: 'user:1', type: 'redeem', points: -10, balanceAfter: 40 });
  assert.equal(defaults.reason, null);
  assert.equal(defaults.orderId, null);
  assert.equal(ledger.count(), 2);
});

test('list is owner-scoped and most-recent-first', () => {
  let clock = 0;
  const ledger = new LoyaltyLedger({ now: () => ++clock, idFactory: seq() });
  ledger.record({ owner: 'a', type: 'earn', points: 10, balanceAfter: 10 });
  ledger.record({ owner: 'b', type: 'earn', points: 5, balanceAfter: 5 });
  const a2 = ledger.record({ owner: 'a', type: 'redeem', points: -3, balanceAfter: 7 });
  const listed = ledger.list('a');
  assert.equal(listed.length, 2);
  assert.equal(listed[0].id, a2.id, 'newest first');
  assert.deepEqual(ledger.list('nobody'), []);
});

test('maxEntries evicts the oldest on record', () => {
  let clock = 0;
  const ledger = new LoyaltyLedger({ maxEntries: 2, now: () => ++clock, idFactory: seq() });
  const first = ledger.record({ owner: 'a', type: 'earn', points: 1, balanceAfter: 1 });
  ledger.record({ owner: 'a', type: 'earn', points: 1, balanceAfter: 2 });
  ledger.record({ owner: 'a', type: 'earn', points: 1, balanceAfter: 3 });
  assert.equal(ledger.count(), 2);
  assert.equal(ledger.list('a').some((t) => t.id === first.id), false, 'the oldest transaction was evicted');
});

test('persists to JSONL, reloads, caps and skips corruption', () => {
  const { path } = tmp();
  const ledger = new LoyaltyLedger({ filePath: path, now: () => 1, idFactory: seq() });
  ledger.record({ owner: 'a', type: 'earn', points: 25, reason: 'welcome', balanceAfter: 25 });
  assert.ok(readFileSync(path, 'utf8').includes('welcome'));

  const reloaded = new LoyaltyLedger({ filePath: path });
  assert.equal(reloaded.count(), 1);

  writeFileSync(path, [
    'not json',
    JSON.stringify({ noId: true }),
    JSON.stringify({ id: 'k1', owner: 'a', type: 'earn', points: 3, balanceAfter: 3, createdAt: 3 }),
    JSON.stringify({ id: 'k2', owner: 'a', type: 'earn', points: 1, balanceAfter: 1, createdAt: 1 })
  ].join('\n'));
  const capped = new LoyaltyLedger({ filePath: path, maxEntries: 1 });
  assert.equal(capped.count(), 1);
  assert.equal(capped.list('a')[0].id, 'k1', 'the most recent record is kept');
});

test('load tolerates records without a createdAt when sorting', () => {
  const { path } = tmp();
  writeFileSync(path, [
    JSON.stringify({ id: 'a', owner: 'x', type: 'earn', points: 1, balanceAfter: 1 }),
    JSON.stringify({ id: 'b', owner: 'x', type: 'earn', points: 2, balanceAfter: 3 })
  ].join('\n'));
  assert.equal(new LoyaltyLedger({ filePath: path }).count(), 2);
});

test('load is a no-op for a missing file and tolerates an unreadable path', () => {
  const { path, dir } = tmp();
  assert.equal(new LoyaltyLedger({ filePath: join(path, 'nope.jsonl') }).count(), 0);
  const ledger = new LoyaltyLedger({ filePath: dir }); // a directory: readFileSync throws
  assert.ok(ledger.lastPersistError);
  assert.equal(ledger.count(), 0);
  rmSync(dir, { recursive: true, force: true });
});

test('persist writes empty and records a failure without throwing', () => {
  const { path } = tmp();
  const empty = new LoyaltyLedger({ filePath: path });
  empty.persist();
  assert.equal(readFileSync(path, 'utf8'), '');

  const { dir } = tmp();
  const ledger = new LoyaltyLedger({ filePath: dir, idFactory: seq() });
  ledger.record({ owner: 'a', type: 'earn', points: 1, balanceAfter: 1 });
  assert.ok(ledger.lastPersistError);
  assert.equal(ledger.count(), 1);
  rmSync(dir, { recursive: true, force: true });
});
