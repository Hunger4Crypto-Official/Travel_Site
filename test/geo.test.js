import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCityCode, knownCityCount } from '../src/utils/geo.js';

test('resolveCityCode passes 3-letter codes through and resolves known city names', () => {
  assert.equal(resolveCityCode('las'), 'LAS');
  assert.equal(resolveCityCode('Las Vegas'), 'LAS');
  assert.equal(resolveCityCode('  Miami '), 'MIA');
  assert.equal(resolveCityCode('Xanadu on Sea'), null);
  assert.equal(resolveCityCode(''), null);
  assert.equal(resolveCityCode(undefined), null);
  assert.ok(knownCityCount() > 0);
});

test('resolveCityCode resolves major world destinations from the expanded dataset', () => {
  // Multi-airport cities resolve to their primary hub (listed first).
  assert.equal(resolveCityCode('London'), 'LHR');
  assert.equal(resolveCityCode('Paris'), 'CDG');
  assert.equal(resolveCityCode('Tokyo'), 'NRT');
  assert.equal(resolveCityCode('Dubai'), 'DXB');
  assert.equal(resolveCityCode('Singapore'), 'SIN');
  assert.equal(resolveCityCode('Sydney'), 'SYD');
  assert.equal(resolveCityCode('Bangkok'), 'BKK');
  assert.equal(resolveCityCode('Istanbul'), 'IST');
  // Case-insensitive across regions.
  assert.equal(resolveCityCode('cape town'), 'CPT');
  assert.equal(resolveCityCode('BUENOS AIRES'), 'EZE');
});

test('the expanded dataset resolves far more cities than the original ~40', () => {
  assert.ok(knownCityCount() > 150, `expected >150 cities, got ${knownCityCount()}`);
});
