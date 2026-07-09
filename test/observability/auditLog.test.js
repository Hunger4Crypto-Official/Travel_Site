import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog } from '../../src/observability/auditLog.js';

function tempFile(name = 'audit.jsonl') {
  const dir = mkdtempSync(join(tmpdir(), 'auditlog-'));
  return { dir, path: join(dir, name) };
}

test('record returns the event and list is most-recent-first', () => {
  let clock = 100;
  let seq = 0;
  const log = new AuditLog({ now: () => (clock += 10), idFactory: () => `id-${++seq}` });

  const first = log.record({ actor: 'alice', action: 'login' });
  const second = log.record({ actor: 'bob', action: 'book', target: 'trip-1', outcome: 'fail', meta: { note: 'x' } });

  assert.equal(first.id, 'id-1');
  assert.equal(first.actor, 'alice');
  assert.equal(first.target, null);
  assert.equal(first.outcome, 'ok');
  assert.deepEqual(first.meta, {});
  assert.equal(second.target, 'trip-1');
  assert.equal(second.outcome, 'fail');

  const listed = log.list();
  assert.deepEqual(listed.map((e) => e.id), ['id-2', 'id-1']);
  assert.equal(log.list({ limit: 1 }).length, 1);
  assert.equal(log.list({ limit: 1 })[0].id, 'id-2');
});

test('record with no argument uses defaults', () => {
  const log = new AuditLog();
  const event = log.record();
  assert.equal(event.actor, undefined);
  assert.equal(event.outcome, 'ok');
  assert.deepEqual(event.meta, {});
  assert.equal(typeof event.id, 'string');
  assert.equal(typeof event.at, 'number');
});

test('redacts secret-like meta keys, including one level of nesting', () => {
  const log = new AuditLog();
  const event = log.record({
    actor: 'alice',
    action: 'auth',
    meta: {
      password: 'hunter2',
      apiToken: 'abc',
      Cookie: 'sess=1',
      username: 'alice',
      count: 3,
      empty: null,
      tags: ['a', 'b'],
      nested: { secretValue: 's', safe: 'keep' }
    }
  });
  assert.equal(event.meta.password, '[redacted]');
  assert.equal(event.meta.apiToken, '[redacted]');
  assert.equal(event.meta.Cookie, '[redacted]');
  assert.equal(event.meta.username, 'alice');
  assert.equal(event.meta.count, 3);
  assert.equal(event.meta.empty, null);
  assert.deepEqual(event.meta.tags, ['a', 'b']);
  assert.equal(event.meta.nested.secretValue, '[redacted]');
  assert.equal(event.meta.nested.safe, 'keep');
});

test('coerces non-object meta to an empty object', () => {
  const log = new AuditLog();
  assert.deepEqual(log.record({ actor: 'a', action: 'x', meta: null }).meta, {});
  assert.deepEqual(log.record({ actor: 'a', action: 'x', meta: 'nope' }).meta, {});
});

test('evicts the oldest entry past maxEntries', () => {
  let clock = 0;
  let seq = 0;
  const log = new AuditLog({ maxEntries: 2, now: () => ++clock, idFactory: () => `id-${++seq}` });
  log.record({ actor: 'a', action: '1' });
  log.record({ actor: 'a', action: '2' });
  log.record({ actor: 'a', action: '3' });
  const ids = log.list().map((e) => e.id);
  assert.deepEqual(ids, ['id-3', 'id-2']);
  assert.equal(log.byId.size, 2);
});

test('persists to JSONL and reloads', () => {
  const { path } = tempFile();
  let seq = 0;
  const log = new AuditLog({ filePath: path, now: () => 1000 + seq, idFactory: () => `id-${++seq}` });
  log.record({ actor: 'a', action: '1', meta: { token: 'secret' } });
  log.record({ actor: 'b', action: '2' });

  const reloaded = new AuditLog({ filePath: path });
  const ids = reloaded.list().map((e) => e.id);
  assert.deepEqual(ids, ['id-2', 'id-1']);
  // Redaction survives the round trip.
  assert.equal(reloaded.list().find((e) => e.id === 'id-1').meta.token, '[redacted]');
});

test('reload keeps only the newest maxEntries', () => {
  const { path } = tempFile();
  let at = 0;
  const writer = new AuditLog({ filePath: path, now: () => ++at, idFactory: () => `id-${at + 1}` });
  writer.record({ actor: 'a', action: '1' });
  writer.record({ actor: 'a', action: '2' });
  writer.record({ actor: 'a', action: '3' });

  const reloaded = new AuditLog({ filePath: path, maxEntries: 2 });
  assert.deepEqual(reloaded.list().map((e) => e.id), ['id-3', 'id-2']);
});

test('load tolerates corrupt lines, blank lines and id-less records', () => {
  const { path } = tempFile();
  const lines = [
    '',
    '   ',
    '{ not json',
    'null',
    JSON.stringify({ noId: true, at: 1 }),
    JSON.stringify({ id: 'keep', at: 5, actor: 'a', action: 'x' })
  ];
  writeFileSync(path, lines.join('\n'));
  const log = new AuditLog({ filePath: path });
  assert.deepEqual(log.list().map((e) => e.id), ['keep']);
});

test('load sorts events that are missing a timestamp', () => {
  const { path } = tempFile();
  const lines = [
    JSON.stringify({ id: 'with-at', at: 5, actor: 'a', action: 'x' }),
    JSON.stringify({ id: 'no-at', actor: 'a', action: 'y' }),
    JSON.stringify({ id: 'low-at', at: 2, actor: 'a', action: 'z' })
  ];
  writeFileSync(path, lines.join('\n'));
  const log = new AuditLog({ filePath: path });
  // Missing timestamps fall back to 0, so they sort as the oldest entries.
  assert.deepEqual(log.list().map((e) => e.id), ['with-at', 'low-at', 'no-at']);
});

test('list orders in-memory events even when some carry no timestamp', () => {
  let seq = 0;
  const log = new AuditLog({ now: () => 0, idFactory: () => `m-${++seq}` });
  // Force a mix of timestamps so the list() comparator exercises both the
  // present-timestamp and the missing-timestamp (|| 0) branches on either side.
  log.byId.set('a', { id: 'a', at: 30, actor: 'x', action: 'a' });
  log.byId.set('b', { id: 'b', actor: 'x', action: 'b' }); // no `at`
  log.byId.set('c', { id: 'c', at: 20, actor: 'x', action: 'c' });
  assert.deepEqual(log.list().map((e) => e.id), ['a', 'c', 'b']);
});

test('load records lastPersistError when the file cannot be read', () => {
  const { dir } = tempFile();
  // Point filePath at a directory: existsSync is true but readFileSync throws.
  const log = new AuditLog({ filePath: dir });
  assert.ok(log.lastPersistError);
  assert.equal(log.byId.size, 0);
});

test('persist failure records lastPersistError without throwing', () => {
  const badPath = join(tmpdir(), 'auditlog-missing-dir-xyz', 'nested', 'audit.jsonl');
  const log = new AuditLog({ filePath: badPath });
  assert.doesNotThrow(() => log.record({ actor: 'a', action: 'x' }));
  assert.ok(log.lastPersistError);
});

test('persist writes an empty file when there are no events', () => {
  const { path } = tempFile();
  const log = new AuditLog({ filePath: path });
  log.persist();
  assert.equal(readFileSync(path, 'utf8'), '');
  assert.equal(log.lastPersistError, null);
});
