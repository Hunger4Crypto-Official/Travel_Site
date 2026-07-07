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
  ['CURRENCY_TTL_MS', 3600000],
  ['PRICE_HISTORY_MAX_ENTRIES', 5000],
  ['ALERTS_MAX_ENTRIES', 1000],
  ['ALERTS_CHECK_INTERVAL_MS', 300000],
  ['ACCOUNTS_MAX_ENTRIES', 100000],
  ['SESSION_TTL_MS', 604800000],
  ['ORDERS_MAX_ENTRIES', 50000],
  ['LOYALTY_MAX_ENTRIES', 100000]
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
    // RAPIDAPI_KEY is a shared fallback: one RapidAPI key works for every
    // RapidAPI-hosted API the account is subscribed to.
    aeroDataBoxKey: env.AERODATABOX_RAPIDAPI_KEY || env.RAPIDAPI_KEY || null,
    skyScrapperKey: env.SKYSCRAPPER_RAPIDAPI_KEY || env.RAPIDAPI_KEY || null,
    bookingComKey: env.BOOKINGCOM_RAPIDAPI_KEY || env.RAPIDAPI_KEY || null,
    carRentalKey: env.CARRENTAL_RAPIDAPI_KEY || env.RAPIDAPI_KEY || null,
    travelpayoutsToken: env.TRAVELPAYOUTS_TOKEN || null,
    travelpayoutsMarker: env.TRAVELPAYOUTS_MARKER || null,

    // Currency normalization
    currencyConversionEnabled: env.CURRENCY_CONVERSION_ENABLED === 'true',
    baseCurrency: (env.BASE_CURRENCY || 'USD').toUpperCase(),
    currencyTtlMs: values.CURRENCY_TTL_MS,

    // Price memory ("vs. recent average" context + /v1/prices/history)
    priceHistoryEnabled: env.PRICE_HISTORY_ENABLED !== 'false',
    priceHistoryFile: env.PRICE_HISTORY_FILE || null,
    priceHistoryMaxEntries: values.PRICE_HISTORY_MAX_ENTRIES,

    // Price alerts / saved searches (/v1/alerts + background sweep)
    alertsEnabled: env.ALERTS_ENABLED !== 'false',
    alertsFile: env.ALERTS_FILE || null,
    alertsMaxEntries: values.ALERTS_MAX_ENTRIES,
    alertsCheckIntervalMs: values.ALERTS_CHECK_INTERVAL_MS,
    alertsWebhooksEnabled: env.ALERTS_WEBHOOKS_ENABLED === 'true',

    // Accounts, sessions, and membership (/v1/auth/* + /v1/me)
    accountsEnabled: env.ACCOUNTS_ENABLED !== 'false',
    accountsFile: env.ACCOUNTS_FILE || null,
    accountsMaxEntries: values.ACCOUNTS_MAX_ENTRIES,
    sessionSecret: env.SESSION_SECRET || null,
    sessionTtlMs: values.SESSION_TTL_MS,
    cookieSecure: env.COOKIE_SECURE === 'true' || nodeEnv === 'production',

    // Managed booking (/v1/orders): aggregators are the merchant of record.
    bookingEnabled: env.BOOKING_ENABLED !== 'false',
    ordersFile: env.ORDERS_FILE || null,
    ordersMaxEntries: values.ORDERS_MAX_ENTRIES,
    duffelToken: env.DUFFEL_TOKEN || null,
    duffelEnv: env.DUFFEL_ENV === 'production' ? 'production' : 'test',

    // Membership billing (/v1/billing): Stripe is the merchant of record for
    // the recurring subscription charge.
    billingEnabled: env.BILLING_ENABLED !== 'false',
    stripeSecretKey: env.STRIPE_SECRET_KEY || null,
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || null,
    stripePriceSilver: env.STRIPE_PRICE_SILVER || null,
    stripePriceGold: env.STRIPE_PRICE_GOLD || null,

    // Loyalty program (/v1/loyalty): points earned on bookings, redeemed for credit.
    loyaltyEnabled: env.LOYALTY_ENABLED !== 'false',
    loyaltyFile: env.LOYALTY_FILE || null,
    loyaltyMaxEntries: values.LOYALTY_MAX_ENTRIES
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
