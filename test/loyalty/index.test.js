import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountStore } from '../../src/accounts/accountStore.js';
import { createLoyaltyService } from '../../src/loyalty/index.js';

const config = { loyaltyEnabled: true, loyaltyFile: null, loyaltyMaxEntries: 100 };

test('createLoyaltyService returns null when disabled or without an account store', () => {
  assert.equal(createLoyaltyService({ ...config, loyaltyEnabled: false }, new AccountStore({})), null);
  assert.equal(createLoyaltyService(config, null), null);
  assert.ok(createLoyaltyService(config, new AccountStore({})));
});
