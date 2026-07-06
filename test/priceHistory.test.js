import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PriceHistoryStore, priceHistoryKey } from '../src/utils/priceHistory.js';

const DAY = 86400000;

test('priceHistoryKey builds per-vertical keys and returns null when unkeyable', () => {
  assert.equal(priceHistoryKey('flights', { from: ' lax ', to: 'jfk' }), 'LAX-JFK');
  assert.equal(priceHistoryKey('flights', { from: 'LAX' }), null);
  assert.equal(priceHistoryKey('flights', {}), null); // both endpoints missing
  assert.equal(priceHistoryKey('hotels', { city: 'Las Vegas', checkin: '2027-05-01', checkout: '2027-05-04' }), 'las vegas|3n');
  assert.equal(priceHistoryKey('hotels', { city: 'Las Vegas' }), 'las vegas|any'); // no dates -> unknown stay length
  assert.equal(priceHistoryKey('hotels', { city: 'X', checkin: '2027-05-04', checkout: '2027-05-01' }), 'x|any'); // inverted dates
  assert.equal(priceHistoryKey('hotels', {}), null);
  assert.equal(priceHistoryKey('cars', { city: 'Miami' }), 'miami');
  assert.equal(priceHistoryKey('cars', {}), null);
  assert.equal(priceHistoryKey('tracking', { icao24: '4b1814' }), null); // no meaningful price
});

test('record stores entries, ignores non-finite totals, and bounds memory', () => {
  let clock = 1000;
  const store = new PriceHistoryStore({ maxEntries: 3, now: () => clock });

  assert.equal(store.record({ type: 'flights', key: 'LAX-JFK', currency: 'USD', total: NaN, provider: 'x' }), null);
  for (const total of [100, 110, 120, 130]) {
    clock += 1;
    store.record({ type: 'flights', key: 'LAX-JFK', currency: 'USD', total, provider: 'p' });
  }

  assert.equal(store.entries.length, 3); // oldest evicted
  assert.equal(store.entries[0].total, 110);
});

test('stats aggregates within the window and per currency; series is capped and ordered', () => {
  let clock = 100 * DAY;
  const store = new PriceHistoryStore({ now: () => clock });
  store.record({ type: 'flights', key: 'LAX-JFK', currency: 'USD', total: 100, provider: 'a' });
  clock += DAY;
  store.record({ type: 'flights', key: 'LAX-JFK', currency: 'USD', total: 200, provider: 'b' });
  clock += DAY;
  store.record({ type: 'flights', key: 'LAX-JFK', currency: 'EUR', total: 999, provider: 'c' }); // other currency
  store.record({ type: 'hotels', key: 'vegas|3n', currency: 'USD', total: 50, provider: 'd' }); // other key

  const stats = store.stats({ type: 'flights', key: 'LAX-JFK', currency: 'USD' });
  assert.deepEqual(stats, { samples: 2, average: 150, lowest: 100, latest: 200 });

  // Outside the window nothing matches.
  clock += 40 * DAY;
  assert.equal(store.stats({ type: 'flights', key: 'LAX-JFK', currency: 'USD' }), null);

  clock -= 40 * DAY;
  const series = store.series({ type: 'flights', key: 'LAX-JFK', currency: 'USD', limit: 1 });
  assert.equal(series.length, 1);
  assert.equal(series[0].total, 200); // newest kept when capped
  assert.match(series[0].at, /^\d{4}-\d{2}-\d{2}T/);
});

test('latestFor returns the newest entry for a key regardless of currency', () => {
  let clock = 1;
  const store = new PriceHistoryStore({ now: () => clock });
  assert.equal(store.latestFor('flights', 'LAX-JFK'), null);
  store.record({ type: 'flights', key: 'LAX-JFK', currency: 'USD', total: 100, provider: 'a' });
  clock += 1;
  store.record({ type: 'flights', key: 'LAX-JFK', currency: 'EUR', total: 90, provider: 'b' });
  assert.equal(store.latestFor('flights', 'LAX-JFK').currency, 'EUR');
});

test('persists to a JSONL file and reloads it, skipping malformed lines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'price-history-'));
  const file = join(dir, 'history.jsonl');
  let clock = 5;

  const store = new PriceHistoryStore({ filePath: file, now: () => clock });
  store.record({ type: 'flights', key: 'LAX-JFK', currency: 'USD', total: 100, provider: 'a' });
  store.record({ type: 'flights', key: 'LAX-JFK', currency: 'USD', total: 120, provider: 'b' });
  assert.equal(store.lastPersistError, null);
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 2);

  // Corrupt one line and append a structurally-valid-but-priceless one.
  writeFileSync(file, `${readFileSync(file, 'utf8')}not json\n{"t":6,"total":"n/a"}\n`);

  const reloaded = new PriceHistoryStore({ filePath: file, now: () => clock });
  assert.equal(reloaded.entries.length, 2); // both bad lines skipped
  assert.equal(reloaded.stats({ type: 'flights', key: 'LAX-JFK', currency: 'USD' }).samples, 2);
});

test('reload trims the file to maxEntries and a missing file is a no-op', () => {
  const dir = mkdtempSync(join(tmpdir(), 'price-history-'));
  const file = join(dir, 'history.jsonl');
  const lines = [1, 2, 3, 4].map((total) => JSON.stringify({ t: total, type: 'cars', key: 'miami', currency: 'USD', total, provider: 'p' }));
  writeFileSync(file, `${lines.join('\n')}\n`);

  const trimmed = new PriceHistoryStore({ filePath: file, maxEntries: 2, now: () => 10 });
  assert.deepEqual(trimmed.entries.map((e) => e.total), [3, 4]);

  const missing = new PriceHistoryStore({ filePath: join(dir, 'nope.jsonl') });
  assert.deepEqual(missing.entries, []);
});

test('a failing persist path never breaks recording', () => {
  const store = new PriceHistoryStore({ filePath: '/nonexistent-dir/deep/history.jsonl', now: () => 1 });
  const entry = store.record({ type: 'cars', key: 'miami', currency: 'USD', total: 42, provider: 'p' });
  assert.equal(entry.total, 42); // record succeeded in memory
  assert.ok(store.lastPersistError); // and the failure is observable
});

test('the default clock stamps entries with the current time', () => {
  const before = Date.now();
  const entry = new PriceHistoryStore().record({ type: 'cars', key: 'miami', currency: 'USD', total: 10, provider: 'p' });
  assert.ok(entry.t >= before && entry.t <= Date.now());
});
