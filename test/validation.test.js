import test from 'node:test';
import assert from 'node:assert/strict';
import { validateQuery, stableCacheKey } from '../src/engine/queryValidation.js';

test('validateQuery reports a single missing parameter', () => {
  assert.throws(() => validateQuery('flights', { from: 'LAX' }), /Missing required query parameter: to/);
});

test('validateQuery reports multiple missing parameters (plural)', () => {
  assert.throws(() => validateQuery('flights', {}), /Missing required query parameters: from, to/);
});

test('validateQuery rejects over-long parameters', () => {
  assert.throws(
    () => validateQuery('hotels', { city: 'x'.repeat(200) }, { maxQueryLength: 50 }),
    /too long: city/
  );
});

test('validateQuery rejects malformed and impossible dates', () => {
  assert.throws(() => validateQuery('flights', { from: 'LAX', to: 'JFK', date: 'nope' }), /Invalid date format/);
  assert.throws(() => validateQuery('flights', { from: 'LAX', to: 'JFK', date: '2026-02-30' }), /Invalid date format/);
});

test('validateQuery validates optional cityCode', () => {
  assert.throws(() => validateQuery('hotels', { city: 'Palma', cityCode: 'PALMA' }), /Invalid cityCode/);
  const ok = validateQuery('hotels', { city: 'Palma', cityCode: 'pmi', checkin: '2026-07-01', checkout: '2026-07-05' });
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
    () => validateQuery('hotels', { city: 'X', checkin: '2026-07-05', checkout: '2026-07-01' }),
    /checkout must be after checkin/
  );
  assert.throws(() => validateQuery('flights', { from: 'LAX', to: 'JFK', sort: 'bogus' }), /Invalid sort/);
});

test('validateQuery trims and returns a normalized query for valid input', () => {
  const out = validateQuery('flights', { from: ' lax ', to: 'JFK', date: '2026-07-01', sort: 'score' });
  assert.equal(out.from, 'lax');
  assert.equal(out.sort, 'score');
});

test('stableCacheKey is order- and whitespace-independent', () => {
  assert.equal(
    stableCacheKey('flights', { from: ' LAX ', to: 'JFK' }),
    stableCacheKey('flights', { to: 'JFK', from: 'LAX' })
  );
});
