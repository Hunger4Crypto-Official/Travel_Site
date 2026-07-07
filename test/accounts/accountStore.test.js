import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountStore } from '../../src/accounts/accountStore.js';

function tmpFile() {
  const dir = mkdtempSync(join(tmpdir(), 'accts-'));
  return { path: join(dir, 'accounts.jsonl'), dir };
}

function seq(prefix = 'id') {
  let n = 0;
  return () => `${prefix}${++n}`;
}

test('create assigns fields and defaults, enforces unique email', () => {
  const store = new AccountStore({ now: () => 1000, idFactory: seq() });
  const user = store.create({ email: 'a@b.com', passwordHash: 'h1' });
  assert.equal(user.id, 'id1');
  assert.equal(user.email, 'a@b.com');
  assert.equal(user.tier, 'free');
  assert.equal(user.role, 'member');
  assert.equal(user.loyaltyPoints, 0);
  assert.equal(user.createdAt, 1000);
  assert.equal(user.updatedAt, 1000);

  const custom = store.create({ email: 'c@d.com', passwordHash: 'h2', tier: 'gold', role: 'admin' });
  assert.equal(custom.tier, 'gold');
  assert.equal(custom.role, 'admin');

  assert.throws(() => store.create({ email: 'a@b.com', passwordHash: 'h3' }), (err) => {
    assert.equal(err.statusCode, 409);
    return true;
  });
});

test('get and findByEmail hit and miss', () => {
  const store = new AccountStore({ idFactory: seq() });
  const user = store.create({ email: 'x@y.com', passwordHash: 'h' });
  assert.equal(store.get(user.id).email, 'x@y.com');
  assert.equal(store.get('missing'), null);
  assert.equal(store.findByEmail('x@y.com').id, user.id);
  assert.equal(store.findByEmail('none@y.com'), null);
  assert.equal(store.count(), 1);
});

test('update patches, bumps updatedAt, and keeps email/id immutable', () => {
  let clock = 5;
  const store = new AccountStore({ now: () => clock, idFactory: seq() });
  const user = store.create({ email: 'e@f.com', passwordHash: 'h' });
  clock = 9;
  const updated = store.update(user.id, { tier: 'silver', email: 'evil@f.com', id: 'hacked', loyaltyPoints: 50 });
  assert.equal(updated.tier, 'silver');
  assert.equal(updated.loyaltyPoints, 50);
  assert.equal(updated.email, 'e@f.com', 'email is not overwritten');
  assert.equal(updated.id, user.id, 'id is not overwritten');
  assert.equal(updated.updatedAt, 9);
  assert.equal(store.update('nope', { tier: 'gold' }), null);
});

test('persists to JSONL and reloads, respecting maxEntries and skipping corruption', () => {
  const { path } = tmpFile();
  const store = new AccountStore({ filePath: path, now: () => 1, idFactory: seq() });
  store.create({ email: 'one@x.com', passwordHash: 'h1' });
  store.create({ email: 'two@x.com', passwordHash: 'h2' });
  assert.ok(readFileSync(path, 'utf8').includes('one@x.com'));

  // A fresh store over the same file reloads both users.
  const reloaded = new AccountStore({ filePath: path, idFactory: seq() });
  assert.equal(reloaded.count(), 2);
  assert.equal(reloaded.findByEmail('two@x.com').passwordHash, 'h2');

  // Corrupt line + a well-formed-but-not-a-user line are both skipped.
  writeFileSync(path, [
    'not json',
    JSON.stringify({ id: 'z', notAUser: true }),
    JSON.stringify({ id: 'k1', email: 'keep@x.com', passwordHash: 'h', createdAt: 2 }),
    ''
  ].join('\n'));
  const afterCorrupt = new AccountStore({ filePath: path, idFactory: seq() });
  assert.equal(afterCorrupt.count(), 1);
  assert.equal(afterCorrupt.findByEmail('keep@x.com').id, 'k1');
});

test('load caps to the most recent maxEntries by createdAt', () => {
  const { path } = tmpFile();
  writeFileSync(path, [
    JSON.stringify({ id: 'a', email: 'a@x.com', passwordHash: 'h', createdAt: 1 }),
    JSON.stringify({ id: 'b', email: 'b@x.com', passwordHash: 'h', createdAt: 3 }),
    JSON.stringify({ id: 'c', email: 'c@x.com', passwordHash: 'h', createdAt: 2 })
  ].join('\n'));
  const store = new AccountStore({ filePath: path, maxEntries: 2 });
  assert.equal(store.count(), 2);
  // The oldest (createdAt 1) is dropped; the two newest are kept.
  assert.equal(store.get('a'), null);
  assert.ok(store.get('b'));
  assert.ok(store.get('c'));
});

test('load is a no-op when the file does not exist', () => {
  const { path } = tmpFile();
  const store = new AccountStore({ filePath: join(path, 'nope', 'accounts.jsonl') });
  assert.equal(store.count(), 0);
});

test('load tolerates records without a createdAt when sorting', () => {
  const { path } = tmpFile();
  writeFileSync(path, [
    JSON.stringify({ id: 'a', email: 'a@x.com', passwordHash: 'h' }),
    JSON.stringify({ id: 'b', email: 'b@x.com', passwordHash: 'h' })
  ].join('\n'));
  const store = new AccountStore({ filePath: path });
  assert.equal(store.count(), 2);
});

test('findByEmail returns null when the email index points at a missing record', () => {
  const store = new AccountStore({ idFactory: seq() });
  store.byEmail.set('drift@x.com', 'ghost-id');
  assert.equal(store.findByEmail('drift@x.com'), null);
});

test('persist writes an empty file when there are no records', () => {
  const { path } = tmpFile();
  const store = new AccountStore({ filePath: path });
  store.persist();
  assert.equal(readFileSync(path, 'utf8'), '');
});

test('persist failure is recorded, never thrown', () => {
  const { dir } = tmpFile();
  // Point the store at a directory path so writeFileSync throws (EISDIR).
  const store = new AccountStore({ filePath: dir, idFactory: seq() });
  store.create({ email: 'p@x.com', passwordHash: 'h' });
  assert.ok(store.lastPersistError, 'a failed write records lastPersistError');
  assert.equal(store.count(), 1, 'the in-memory mutation still succeeds');
  rmSync(dir, { recursive: true, force: true });
});
