import { MockProvider } from './mockProvider.js';

export function createProviders(config = {}) {
  const providers = [];

  if (config.demoProviderEnabled !== false) {
    providers.push(new MockProvider({
      name: 'the-travel-club-demo',
      affiliateId: config.demoAffiliateId,
      timeoutMs: config.providerTimeoutMs
    }));
  }

  return providers;
}
