import { MockProvider } from './mockProvider.js';
import { AirportInfoProvider } from './airportInfoProvider.js';
import { OpenSkyProvider } from './openSkyProvider.js';
import { AdsbProvider } from './adsbProvider.js';
import { HotelbedsProvider } from './hotelbedsProvider.js';
import { AeroDataBoxProvider } from './aeroDataBoxProvider.js';
import { TravelpayoutsProvider } from './travelpayoutsProvider.js';

// Builds the active provider set from configuration. No-key real providers and
// the demo provider are on by default; key-based providers are registered only
// when their credentials are present, so unconfigured providers never run.
export function createProviders(config = {}) {
  const providers = [];
  const timeoutMs = config.providerTimeoutMs;
  const affiliateId = config.demoAffiliateId;

  // Verticals already covered by a real provider — the demo must not fabricate
  // prices for these, or a placeholder offer could win a real lowest-price race.
  const realFlights = Boolean(config.travelpayoutsToken);
  const realHotels = Boolean(config.hotelbedsApiKey && config.hotelbedsSecret);
  const demoExclude = [];
  if (realFlights) demoExclude.push('flights');
  if (realHotels) demoExclude.push('hotels');

  if (config.demoProviderEnabled !== false) {
    providers.push(new MockProvider({ name: 'the-travel-club-demo', affiliateId, timeoutMs, excludeTypes: demoExclude }));
  }

  if (config.airportProviderEnabled !== false) {
    providers.push(new AirportInfoProvider({ affiliateId, timeoutMs }));
  }

  if (config.openSkyEnabled !== false) {
    providers.push(new OpenSkyProvider({
      affiliateId,
      timeoutMs,
      username: config.openSkyUsername,
      password: config.openSkyPassword
    }));
  }

  if (config.adsbEnabled !== false) {
    providers.push(new AdsbProvider({ name: 'adsb-lol', baseUrl: 'https://api.adsb.lol', affiliateId, timeoutMs }));
    providers.push(new AdsbProvider({ name: 'airplanes-live', baseUrl: 'https://api.airplanes.live', affiliateId, timeoutMs }));
  }

  if (config.hotelbedsApiKey && config.hotelbedsSecret) {
    providers.push(new HotelbedsProvider({
      apiKey: config.hotelbedsApiKey,
      secret: config.hotelbedsSecret,
      environment: config.hotelbedsEnv,
      affiliateId,
      timeoutMs
    }));
  }

  if (config.aeroDataBoxKey) {
    providers.push(new AeroDataBoxProvider({ apiKey: config.aeroDataBoxKey, affiliateId, timeoutMs }));
  }

  if (config.travelpayoutsToken) {
    providers.push(new TravelpayoutsProvider({
      token: config.travelpayoutsToken,
      marker: config.travelpayoutsMarker,
      affiliateId,
      timeoutMs
    }));
  }

  return providers;
}
