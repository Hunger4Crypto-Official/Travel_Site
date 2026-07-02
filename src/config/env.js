const integerSettings = [
  ['PORT', 3000],
  ['CACHE_TTL_MS', 300000],
  ['CACHE_MAX_ENTRIES', 1000],
  ['RATE_LIMIT_CAPACITY', 120],
  ['RATE_LIMIT_REFILL_PER_MINUTE', 120],
  ['PROVIDER_TIMEOUT_MS', 8000],
  ['PROVIDER_FAILURE_THRESHOLD', 3],
  ['PROVIDER_COOLDOWN_MS', 30000],
  ['MAX_QUERY_LENGTH', 120],
  ['CURRENCY_TTL_MS', 3600000]
];

export function loadConfig(env = process.env) {
  const values = Object.fromEntries(integerSettings.map(([key, fallback]) => [key, readInteger(env, key, fallback)]));
  const apiKeys = splitList(env.API_KEYS);
  const nodeEnv = env.NODE_ENV || 'development';
  return {
    nodeEnv,
    port: values.PORT,
    cacheTtlMs: values.CACHE_TTL_MS,
    cacheMaxEntries: values.CACHE_MAX_ENTRIES,
    rateLimitCapacity: values.RATE_LIMIT_CAPACITY,
    rateLimitRefillPerMinute: values.RATE_LIMIT_REFILL_PER_MINUTE,
    providerTimeoutMs: values.PROVIDER_TIMEOUT_MS,
    providerFailureThreshold: values.PROVIDER_FAILURE_THRESHOLD,
    providerCooldownMs: values.PROVIDER_COOLDOWN_MS,
    maxQueryLength: values.MAX_QUERY_LENGTH,
    requestLogLevel: env.REQUEST_LOG_LEVEL || 'info',
    allowedOrigins: splitList(env.ALLOWED_ORIGINS, ['http://localhost:3000']),
    apiKeys,
    requireApiKey: env.REQUIRE_API_KEY === 'true' || (nodeEnv === 'production' && apiKeys.length > 0),

    // Demo + no-key real providers
    demoProviderEnabled: env.DEMO_PROVIDER_ENABLED !== 'false',
    demoAffiliateId: env.DEMO_AFFILIATE_ID || null,
    airportProviderEnabled: env.AIRPORT_PROVIDER_ENABLED !== 'false',
    openSkyEnabled: env.OPENSKY_ENABLED !== 'false',
    openSkyUsername: env.OPENSKY_USERNAME || null,
    openSkyPassword: env.OPENSKY_PASSWORD || null,
    adsbEnabled: env.ADSB_ENABLED !== 'false',

    // Key-based providers (registered only when configured)
    hotelbedsApiKey: env.HOTELBEDS_API_KEY || null,
    hotelbedsSecret: env.HOTELBEDS_SECRET || null,
    hotelbedsEnv: env.HOTELBEDS_ENV === 'production' ? 'production' : 'test',
    aeroDataBoxKey: env.AERODATABOX_RAPIDAPI_KEY || null,
    travelpayoutsToken: env.TRAVELPAYOUTS_TOKEN || null,
    travelpayoutsMarker: env.TRAVELPAYOUTS_MARKER || null,

    // Currency normalization
    currencyConversionEnabled: env.CURRENCY_CONVERSION_ENABLED === 'true',
    baseCurrency: (env.BASE_CURRENCY || 'USD').toUpperCase(),
    currencyTtlMs: values.CURRENCY_TTL_MS
  };
}

function readInteger(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${key} must be a non-negative integer`);
  }
  return value;
}

function splitList(value, fallback = []) {
  if (!value) return fallback;
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}
