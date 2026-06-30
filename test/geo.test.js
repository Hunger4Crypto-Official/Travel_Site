import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCityCode, knownCityCount } from '../src/utils/geo.js';

test('resolveCityCode passes 3-letter codes through and resolves known city names', () => {
  assert.equal(resolveCityCode('las'), 'LAS');
  assert.equal(resolveCityCode('Las Vegas'), 'LAS');
  assert.equal(resolveCityCode('  Miami '), 'MIA');
  assert.equal(resolveCityCode('Nowhereville'), null);
  assert.equal(resolveCityCode(''), null);
  assert.equal(resolveCityCode(undefined), null);
  assert.ok(knownCityCount() > 0);
});
