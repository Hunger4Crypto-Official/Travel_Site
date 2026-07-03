import test from 'node:test';
import assert from 'node:assert/strict';
import { validateQuery, stableCacheKey } from '../src/engine/queryValidation.js';

// A fixed "today" so date validation is deterministic regardless of when the
// suite runs. All sample dates below are on/after this date.
const NOW = Date.UTC(2026, 0, 1); // 2026-01-01
const opts = (extra = {}) => ({ now: NOW, ...extra });

test('validateQuery reports a single missing parameter', () => {
  assert.throws(() => validateQuery('flights', { from: 'LAX' }), /Missing required query parameter: to/);
});

test('validateQuery reports multiple missing parameters (plural)', () => {
  assert.throws(() => validateQuery('flights', {}), /Missing required query parameters: from, to/);
});

test('validateQuery rejects over-long parameters (known and unknown)', () => {
  assert.throws(
    () => validateQuery('hotels', { city: 'x'.repeat(200) }, { maxQueryLength: 50 }),
    /too long: city/
  );
  // Unknown fields are length-capped too, so they cannot bloat the cache key.
  assert.throws(
    () => validateQuery('flights', { from: 'LAX', to: 'JFK', junk: 'y'.repeat(200) }, { maxQueryLength: 50 }),
    /too long: junk/
  );
});

test('validateQuery rejects too many parameters', () => {
  const many = { from: 'LAX', to: 'JFK' };
  for (let i = 0; i < 30; i += 1) many[`p${i}`] = '1';
  assert.throws(() => validateQuery('flights', many, { maxParams: 24 }), /Too many query parameters/);
});

test('validateQuery rejects malformed and impossible dates', () => {
  assert.throws(() => validateQuery('flights', { from: 'LAX', to: 'JFK', date: 'nope' }), /Invalid date format/);
  assert.throws(() => validateQuery('flights', { from: 'LAX', to: 'JFK', date: '2026-02-30' }), /Invalid date format/);
});

test('validateQuery validates optional cityCode', () => {
  assert.throws(() => validateQuery('hotels', { city: 'Palma', cityCode: 'PALMA' }), /Invalid cityCode/);
  const ok = validateQuery('hotels', { city: 'Palma', cityCode: 'pmi', checkin: '2026-07-01', checkout: '2026-07-05' }, opts());
  assert.equal(ok.cityCode, 'pmi');
});

test('validateQuery enforces airport code shape and distinct endpoints', () => {
  assert.throws(() => validateQuery('flights', { from: '12', to: 'JFK' }), /Invalid airport code for from/);
  assert.throws(() => validateQuery('flights', { from: 'LAX', to: 'LAX' }), /must be different/);
  assert.throws(() => validateQuery('airports', { code: 'LONGCODE' }), /Invalid airport code for code/);
});

test('validateQuery enforces icao24 and date ordering and sort', () => {
  assert.throws(() => validateQuery('tracking', { icao24: 'xyz' }), /Invalid icao24/);
  assert.throws(
    () => validateQuery('hotels', { city: 'X', checkin: '2026-07-05', checkout: '2026-07-01' }, opts()),
    /checkout must be after checkin/
  );
  assert.throws(() => validateQuery('flights', { from: 'LAX', to: 'JFK', sort: 'bogus' }), /Invalid sort/);
});

test('validateQuery enforces non-negative integers for numeric fields', () => {
  assert.throws(() => validateQuery('flights', { from: 'LAX', to: 'JFK', adults: 'two' }), /Invalid adults/);
  assert.throws(() => validateQuery('flights', { from: 'LAX', to: 'JFK', limit: '-1' }), /Invalid limit. Expected a non-negative integer/);
  assert.throws(() => validateQuery('hotels', { city: 'X', rooms: '1.5' }), /Invalid rooms/);
  const ok = validateQuery('flights', { from: 'LAX', to: 'JFK', adults: '2', children: '0', limit: '10' });
  assert.equal(ok.adults, '2');
});

test('validateQuery enforces the documented limit range of 1-50', () => {
  assert.throws(() => validateQuery('flights', { from: 'LAX', to: 'JFK', limit: '0' }), /integer from 1 to 50/);
  assert.throws(() => validateQuery('flights', { from: 'LAX', to: 'JFK', limit: '51' }), /integer from 1 to 50/);
  assert.throws(() => validateQuery('flights', { from: 'LAX', to: 'JFK', limit: '999' }), /integer from 1 to 50/);
  assert.equal(validateQuery('flights', { from: 'LAX', to: 'JFK', limit: '1' }).limit, '1');
  assert.equal(validateQuery('flights', { from: 'LAX', to: 'JFK', limit: '50' }).limit, '50');
});

test('validateQuery rejects past dates but accepts today and future', () => {
  assert.throws(
    () => validateQuery('flights', { from: 'LAX', to: 'JFK', date: '2025-12-31' }, opts()),
    /date cannot be in the past/
  );
  assert.throws(
    () => validateQuery('hotels', { city: 'X', checkin: '2025-11-01', checkout: '2026-07-05' }, opts()),
    /checkin cannot be in the past/
  );
  // The clock day itself is allowed.
  const today = validateQuery('flights', { from: 'LAX', to: 'JFK', date: '2026-01-01' }, opts());
  assert.equal(today.date, '2026-01-01');
  const future = validateQuery('flights', { from: 'LAX', to: 'JFK', date: '2026-07-01' }, opts());
  assert.equal(future.date, '2026-07-01');
});

test('validateQuery trims and returns a normalized query for valid input', () => {
  const out = validateQuery('flights', { from: ' lax ', to: 'JFK', date: '2026-07-01', sort: 'score' }, opts());
  assert.equal(out.from, 'lax');
  assert.equal(out.sort, 'score');
});

test('validateQuery allows an unknown type (no required fields) and passes unknown short fields through', () => {
  // An unrecognized type has no required-field list, so it should not throw for "missing".
  const out = validateQuery('widgets', { anything: 'ok' });
  assert.equal(out.anything, 'ok');
  // A short unknown field on a known type is length-capped but otherwise ignored.
  const flights = validateQuery('flights', { from: 'LAX', to: 'JFK', foo: 'bar' });
  assert.equal(flights.foo, 'bar');
  // Non-string values (e.g. a numeric limit) pass through normalization untrimmed.
  const numeric = validateQuery('flights', { from: 'LAX', to: 'JFK', adults: 2 });
  assert.equal(numeric.adults, 2);
});

test('stableCacheKey is order- and whitespace-independent', () => {
  assert.equal(
    stableCacheKey('flights', { from: ' LAX ', to: 'JFK' }),
    stableCacheKey('flights', { to: 'JFK', from: 'LAX' })
  );
});
