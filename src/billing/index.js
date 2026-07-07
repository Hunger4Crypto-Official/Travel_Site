import { fetchJson as defaultFetchJson } from '../utils/httpClient.js';
import { createStripeGateway } from './paymentGateway.js';
import { BillingService } from './billingService.js';

// Assemble the billing service: a Stripe gateway (sandbox until a secret key is
// set) plus the shared AccountStore it upgrades/downgrades. Returns null when
// billing is disabled or accounts are not available. fetchJson is injectable
// for tests. Gateway request bodies are already form-encoded strings, so no
// body serialization is needed here, only a timeout.
export function createBillingService(config, accountStore, { fetchJson = defaultFetchJson } = {}) {
  if (!config.billingEnabled || !accountStore) return null;

  const gatewayFetch = (url, options = {}) => fetchJson(url, { ...options, timeoutMs: config.providerTimeoutMs });
  const gateway = createStripeGateway({ secretKey: config.stripeSecretKey, fetchJson: gatewayFetch });

  return new BillingService({
    store: accountStore,
    gateway,
    priceIds: { silver: config.stripePriceSilver, gold: config.stripePriceGold },
    webhookSecret: config.stripeWebhookSecret,
    requireLiveGateway: config.nodeEnv === 'production'
  });
}
