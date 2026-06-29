import { MockProvider } from './mockProvider.js';
import { AirportInfoProvider } from './airportInfoProvider.js';
import { OpenSkyProvider } from './openSkyProvider.js';

export function createProviders(config = {}) {
  const providers = [];

  if (config.demoProviderEnabled !== false) {
    providers.push(new MockProvider({
      name: 'the-travel-club-demo',
      affiliateId: config.demoAffiliateId,
      timeoutMs: config.providerTimeoutMs
    }));
  }

  if (config.airportProviderEnabled !== false) {
    providers.push(new AirportInfoProvider({
      affiliateId: config.demoAffiliateId,
      timeoutMs: config.providerTimeoutMs
    }));
  }

  if (config.openSkyEnabled !== false) {
    providers.push(new OpenSkyProvider({
      affiliateId: config.demoAffiliateId,
      timeoutMs: config.providerTimeoutMs,
      username: config.openSkyUsername,
      password: config.openSkyPassword
    }));
  }

  return providers;
}
