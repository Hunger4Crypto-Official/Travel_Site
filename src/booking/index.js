import { fetchJson as defaultFetchJson } from '../utils/httpClient.js';
import { OrderStore } from './orderStore.js';
import { BookingService } from './bookingService.js';
import { createDuffelAdapter } from './duffelAdapter.js';
import { createBedbankAdapter } from './bedbankAdapter.js';

// fetchText sends the body straight to fetch, which needs a string; serialize
// object bodies so every adapter can pass a plain object.
export function serializeBody(body) {
  if (body && typeof body !== 'string') return JSON.stringify(body);
  return body;
}

// Assemble the booking service from config: an order store plus one adapter per
// vertical. Adapters run in deterministic sandbox mode until real credentials
// are supplied, so booking is fully exercisable end to end without live keys.
// Returns null when booking is disabled. fetchJson is injectable for tests.
export function createBookingService(config, { fetchJson = defaultFetchJson } = {}) {
  if (!config.bookingEnabled) return null;

  const jsonFetch = (url, options = {}) => fetchJson(url, {
    ...options,
    timeoutMs: config.providerTimeoutMs,
    body: serializeBody(options.body)
  });

  const store = new OrderStore({ filePath: config.ordersFile, maxEntries: config.ordersMaxEntries });
  const adapters = [
    createDuffelAdapter({ token: config.duffelToken, env: config.duffelEnv, fetchJson: jsonFetch }),
    createBedbankAdapter({ apiKey: config.hotelbedsApiKey, secret: config.hotelbedsSecret, env: config.hotelbedsEnv, fetchJson: jsonFetch })
  ];
  return new BookingService({ store, adapters });
}
