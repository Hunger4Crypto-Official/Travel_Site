import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TIERS,
  getTier,
  tierRank,
  hasMemberRates,
  benefitsFor,
  defaultTierId
} from '../../src/accounts/membership.js';

test('TIERS holds exactly three tiers, cheapest first', () => {
  assert.equal(TIERS.length, 3);
  assert.deepEqual(TIERS.map((t) => t.id), ['free', 'silver', 'gold']);
  assert.deepEqual(TIERS.map((t) => t.priceMonthlyUsd), [0, 9.99, 24.99]);
  assert.deepEqual(TIERS.map((t) => t.name), ['Explorer', 'Voyager', 'Globetrotter']);
  assert.deepEqual(TIERS.map((t) => t.memberRates), [false, true, true]);
  assert.deepEqual(TIERS.map((t) => t.loyaltyMultiplier), [1, 2, 3]);
});

test('no client-facing em dashes appear in names or benefits', () => {
  for (const tier of TIERS) {
    assert.ok(!tier.name.includes('—'), `name has em dash: ${tier.name}`);
    for (const benefit of tier.benefits) {
      assert.ok(!benefit.includes('—'), `benefit has em dash: ${benefit}`);
      assert.equal(typeof benefit, 'string');
    }
    assert.ok(tier.benefits.length > 0);
  }
});

test('getTier returns the matching tier or null', () => {
  assert.equal(getTier('free'), TIERS[0]);
  assert.equal(getTier('silver'), TIERS[1]);
  assert.equal(getTier('gold'), TIERS[2]);
  assert.equal(getTier('platinum'), null);
  assert.equal(getTier(undefined), null);
});

test('tierRank maps ids to their index and defaults unknown ids to 0', () => {
  assert.equal(tierRank('free'), 0);
  assert.equal(tierRank('silver'), 1);
  assert.equal(tierRank('gold'), 2);
  assert.equal(tierRank('platinum'), 0);
  assert.equal(tierRank(''), 0);
});

test('hasMemberRates is true only for paid tiers that grant member rates', () => {
  assert.equal(hasMemberRates('free'), false);
  assert.equal(hasMemberRates('silver'), true);
  assert.equal(hasMemberRates('gold'), true);
  assert.equal(hasMemberRates('platinum'), false);
});

test('benefitsFor returns the tier benefits or an empty array for unknown ids', () => {
  assert.equal(benefitsFor('free'), TIERS[0].benefits);
  assert.equal(benefitsFor('silver'), TIERS[1].benefits);
  assert.equal(benefitsFor('gold'), TIERS[2].benefits);
  assert.deepEqual(benefitsFor('platinum'), []);

  const silver = benefitsFor('silver');
  assert.ok(silver.some((b) => b.toLowerCase().includes('member-only rates')));
  assert.ok(silver.some((b) => b.includes('2x loyalty points')));
  assert.ok(silver.some((b) => b.toLowerCase().includes('priority support')));

  const gold = benefitsFor('gold');
  assert.ok(gold.some((b) => b.includes('Everything in Voyager')));
  assert.ok(gold.some((b) => b.includes('3x loyalty points')));
  assert.ok(gold.some((b) => b.toLowerCase().includes('waived booking service fees')));
  assert.ok(gold.some((b) => b.toLowerCase().includes('concierge')));
});

test('defaultTierId is the free tier', () => {
  assert.equal(defaultTierId(), 'free');
  assert.notEqual(getTier(defaultTierId()), null);
});
