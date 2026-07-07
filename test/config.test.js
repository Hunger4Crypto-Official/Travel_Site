import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config/env.js';

test('loadConfig applies safe defaults with an empty environment', () => {
  const config = loadConfig({});

  assert.equal(config.nodeEnv, 'development');
  assert.equal(config.port, 3000);
  assert.equal(config.requestLogLevel, 'info');
  assert.deepEqual(config.allowedOrigins, ['http://localhost:3000']);
  assert.deepEqual(config.apiKeys, []);
  assert.equal(config.requireApiKey, false);

  assert.equal(config.demoProviderEnabled, true);
  assert.equal(config.demoAffiliateId, null);
  assert.equal(config.airportProviderEnabled, true);
  assert.equal(config.openSkyEnabled, true);
  assert.equal(config.openSkyUsername, null);
  assert.equal(config.openSkyPassword, null);
  assert.equal(config.adsbEnabled, true);

  assert.equal(config.hotelbedsApiKey, null);
  assert.equal(config.hotelbedsSecret, null);
  assert.equal(config.hotelbedsEnv, 'test');
  assert.equal(config.aeroDataBoxKey, null);
  assert.equal(config.skyScrapperKey, null);
  assert.equal(config.bookingComKey, null);
  assert.equal(config.carRentalKey, null);
  assert.equal(config.travelpayoutsToken, null);
  assert.equal(config.travelpayoutsMarker, null);

  assert.equal(config.currencyConversionEnabled, false);
  assert.equal(config.baseCurrency, 'USD');
  assert.equal(config.priceHistoryEnabled, true);
  assert.equal(config.priceHistoryFile, null);
  assert.equal(config.priceHistoryMaxEntries, 5000);

  assert.equal(config.alertsEnabled, true);
  assert.equal(config.alertsFile, null);
  assert.equal(config.alertsMaxEntries, 1000);
  assert.equal(config.alertsCheckIntervalMs, 300000);
  assert.equal(config.alertsWebhooksEnabled, false);
});

test('loadConfig honors every override and the shared RapidAPI fallback', () => {
  const config = loadConfig({
    NODE_ENV: 'production',
    PORT: '4000',
    REQUEST_LOG_LEVEL: 'debug',
    ALLOWED_ORIGINS: 'https://a.example, https://b.example',
    API_KEYS: 'k1, k2',
    DEMO_PROVIDER_ENABLED: 'false',
    DEMO_AFFILIATE_ID: 'aff-1',
    AIRPORT_PROVIDER_ENABLED: 'false',
    OPENSKY_ENABLED: 'false',
    OPENSKY_USERNAME: 'user',
    OPENSKY_PASSWORD: 'pass',
    ADSB_ENABLED: 'false',
    HOTELBEDS_API_KEY: 'hb-key',
    HOTELBEDS_SECRET: 'hb-secret',
    HOTELBEDS_ENV: 'production',
    AERODATABOX_RAPIDAPI_KEY: 'adb-specific',
    RAPIDAPI_KEY: 'shared',
    BOOKINGCOM_RAPIDAPI_KEY: 'bk-specific',
    TRAVELPAYOUTS_TOKEN: 'tp-token',
    TRAVELPAYOUTS_MARKER: 'tp-marker',
    CURRENCY_CONVERSION_ENABLED: 'true',
    BASE_CURRENCY: 'eur',
    PRICE_HISTORY_ENABLED: 'false',
    PRICE_HISTORY_FILE: '/tmp/history.jsonl',
    PRICE_HISTORY_MAX_ENTRIES: '9',
    ALERTS_ENABLED: 'false',
    ALERTS_FILE: '/tmp/alerts.jsonl',
    ALERTS_MAX_ENTRIES: '50',
    ALERTS_CHECK_INTERVAL_MS: '1000',
    ALERTS_WEBHOOKS_ENABLED: 'true',
    ACCOUNTS_ENABLED: 'false',
    ACCOUNTS_FILE: '/tmp/accounts.jsonl',
    ACCOUNTS_MAX_ENTRIES: '5',
    SESSION_SECRET: 'sekret',
    SESSION_TTL_MS: '1000',
    COOKIE_SECURE: 'true',
    BOOKING_ENABLED: 'false',
    ORDERS_FILE: '/tmp/orders.jsonl',
    ORDERS_MAX_ENTRIES: '7',
    DUFFEL_TOKEN: 'duf',
    DUFFEL_ENV: 'production',
    LOYALTY_ENABLED: 'false',
    LOYALTY_FILE: '/tmp/loyalty.jsonl',
    LOYALTY_MAX_ENTRIES: '3',
    ASSISTANT_ENABLED: 'true',
    OLLAMA_URL: 'http://ollama:11434',
    OLLAMA_MODEL: 'mistral',
    OFFER_SIGNING_SECRET: 'osec',
    AUTH_RATE_LIMIT_CAPACITY: '7',
    WRITE_RATE_LIMIT_CAPACITY: '42'
  });

  assert.equal(config.nodeEnv, 'production');
  assert.equal(config.port, 4000);
  assert.equal(config.requestLogLevel, 'debug');
  assert.deepEqual(config.allowedOrigins, ['https://a.example', 'https://b.example']);
  assert.deepEqual(config.apiKeys, ['k1', 'k2']);
  // Production + configured keys -> auth auto-required.
  assert.equal(config.requireApiKey, true);

  assert.equal(config.demoProviderEnabled, false);
  assert.equal(config.demoAffiliateId, 'aff-1');
  assert.equal(config.airportProviderEnabled, false);
  assert.equal(config.openSkyEnabled, false);
  assert.equal(config.openSkyUsername, 'user');
  assert.equal(config.adsbEnabled, false);

  assert.equal(config.hotelbedsEnv, 'production');
  assert.equal(config.aeroDataBoxKey, 'adb-specific'); // specific beats shared
  assert.equal(config.skyScrapperKey, 'shared');       // shared fallback fills the gap
  assert.equal(config.bookingComKey, 'bk-specific');
  assert.equal(config.carRentalKey, 'shared');         // shared RapidAPI key covers cars too
  assert.equal(config.travelpayoutsToken, 'tp-token');
  assert.equal(config.travelpayoutsMarker, 'tp-marker');

  assert.equal(config.currencyConversionEnabled, true);
  assert.equal(config.baseCurrency, 'EUR');
  assert.equal(config.priceHistoryEnabled, false);
  assert.equal(config.priceHistoryFile, '/tmp/history.jsonl');
  assert.equal(config.priceHistoryMaxEntries, 9);

  assert.equal(config.alertsEnabled, false);
  assert.equal(config.alertsFile, '/tmp/alerts.jsonl');
  assert.equal(config.alertsMaxEntries, 50);
  assert.equal(config.alertsCheckIntervalMs, 1000);
  assert.equal(config.alertsWebhooksEnabled, true);

  assert.equal(config.accountsEnabled, false);
  assert.equal(config.accountsFile, '/tmp/accounts.jsonl');
  assert.equal(config.accountsMaxEntries, 5);
  assert.equal(config.sessionSecret, 'sekret');
  assert.equal(config.sessionTtlMs, 1000);
  assert.equal(config.cookieSecure, true);
  assert.equal(config.bookingEnabled, false);
  assert.equal(config.ordersFile, '/tmp/orders.jsonl');
  assert.equal(config.ordersMaxEntries, 7);
  assert.equal(config.duffelToken, 'duf');
  assert.equal(config.duffelEnv, 'production');
  assert.equal(config.loyaltyEnabled, false);
  assert.equal(config.loyaltyFile, '/tmp/loyalty.jsonl');
  assert.equal(config.loyaltyMaxEntries, 3);
  assert.equal(config.assistantEnabled, true);
  assert.equal(config.ollamaUrl, 'http://ollama:11434');
  assert.equal(config.ollamaModel, 'mistral');
  assert.equal(config.offerSigningSecret, 'osec');
  assert.equal(config.authRateLimitCapacity, 7);
  assert.equal(config.writeRateLimitCapacity, 42);
});

test('loadConfig auth flag: explicit REQUIRE_API_KEY and production-without-keys', () => {
  // Explicit opt-in works in development.
  assert.equal(loadConfig({ REQUIRE_API_KEY: 'true' }).requireApiKey, true);
  // Production alone (no keys configured) does not force auth on.
  assert.equal(loadConfig({ NODE_ENV: 'production' }).requireApiKey, false);
});

test('loadConfig rejects invalid integers and treats empty values as defaults', () => {
  assert.throws(() => loadConfig({ PORT: 'abc' }), /PORT must be a non-negative integer/);
  assert.throws(() => loadConfig({ CACHE_TTL_MS: '-5' }), /CACHE_TTL_MS must be a non-negative integer/);
  assert.equal(loadConfig({ PORT: '' }).port, 3000); // empty string -> fallback
});
