import { LoyaltyLedger } from './loyaltyLedger.js';
import { LoyaltyService } from './loyaltyService.js';

// Assemble the loyalty service: a ledger for transaction history plus the shared
// AccountStore that holds each member's running balance. Returns null when
// loyalty is disabled or accounts are not available.
export function createLoyaltyService(config, accountStore) {
  if (!config.loyaltyEnabled || !accountStore) return null;
  const ledger = new LoyaltyLedger({ filePath: config.loyaltyFile, maxEntries: config.loyaltyMaxEntries });
  return new LoyaltyService({ ledger, accountStore });
}
