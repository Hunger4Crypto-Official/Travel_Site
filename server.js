import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { brand } from './src/config/brand.js';
import { loadDotEnv } from './src/config/dotenv.js';
import { loadConfig } from './src/config/env.js';
import { TravelEngine } from './src/engine/travelEngine.js';
import { createProviders } from './src/providers/index.js';
import { handleRequest } from './src/routes/router.js';
import { MemoryCache } from './src/utils/cache.js';
import { KeyedRateLimiter } from './src/utils/rateLimit.js';
import { createLogger } from './src/observability/logger.js';
import { MetricsRegistry } from './src/observability/metrics.js';
import { ProviderCircuitBreaker } from './src/engine/providerCircuitBreaker.js';
import { CurrencyConverter } from './src/utils/currency.js';
import { PriceHistoryStore } from './src/utils/priceHistory.js';
import { AlertStore } from './src/utils/alertStore.js';
import { createNotifier } from './src/utils/notifier.js';
import { AccountStore } from './src/accounts/accountStore.js';
import { AccountService } from './src/accounts/accountService.js';
import { createSessionManager } from './src/accounts/sessions.js';
import { createBookingService } from './src/booking/index.js';
import { createBillingService } from './src/billing/index.js';
import { createLoyaltyService } from './src/loyalty/index.js';

loadDotEnv({ path: new URL('./.env', import.meta.url).pathname });
const config = loadConfig();
const logger = createLogger({ level: config.requestLogLevel });
const currencyConverter = config.currencyConversionEnabled
  ? new CurrencyConverter({ base: config.baseCurrency, ttlMs: config.currencyTtlMs })
  : null;
const priceHistory = config.priceHistoryEnabled
  ? new PriceHistoryStore({ filePath: config.priceHistoryFile, maxEntries: config.priceHistoryMaxEntries })
  : null;
const alertStore = config.alertsEnabled
  ? new AlertStore({ filePath: config.alertsFile, maxEntries: config.alertsMaxEntries })
  : null;
const notifier = createNotifier({ enabled: config.alertsWebhooksEnabled, logger });

let accountService = null;
let accountStore = null;
if (config.accountsEnabled) {
  const sessionSecret = config.sessionSecret || randomBytes(32).toString('hex');
  if (!config.sessionSecret) {
    logger.warn('SESSION_SECRET is not set; using an ephemeral secret (sessions reset on restart)');
  }
  accountStore = new AccountStore({ filePath: config.accountsFile, maxEntries: config.accountsMaxEntries });
  const sessions = createSessionManager({ secret: sessionSecret, ttlMs: config.sessionTtlMs });
  accountService = new AccountService({ store: accountStore, sessions });
}

// Membership billing shares the account store so a subscription change updates
// the member's tier directly.
const billingService = createBillingService(config, accountStore);
// Loyalty shares the account store for member balances; booking awards points.
const loyaltyService = createLoyaltyService(config, accountStore);

const engine = new TravelEngine({
  providers: createProviders(config),
  cache: new MemoryCache({ ttlMs: config.cacheTtlMs, maxEntries: config.cacheMaxEntries }),
  limiter: new KeyedRateLimiter({ capacity: config.rateLimitCapacity, refillPerMinute: config.rateLimitRefillPerMinute }),
  metrics: new MetricsRegistry(),
  circuitBreaker: new ProviderCircuitBreaker({ failureThreshold: config.providerFailureThreshold, cooldownMs: config.providerCooldownMs }),
  maxQueryLength: config.maxQueryLength,
  currencyConverter,
  baseCurrency: config.currencyConversionEnabled ? config.baseCurrency : null,
  priceHistory,
  alertStore,
  notifier,
  logger
});

const openapiSpec = loadOpenapiSpec(logger);
const pages = {
  app: loadPage('./public/app.html', logger),
  admin: loadPage('./public/admin.html', logger)
};

const bookingService = createBookingService(config, { loyalty: loyaltyService });

const server = createServer((req, res) => handleRequest(req, res, { engine, brand, logger, config, openapiSpec, pages, accountService, bookingService, billingService, loyaltyService }));

server.listen(config.port, () => {
  logger.info('Server started', { service: brand.name, acronym: brand.acronym, port: config.port, nodeEnv: config.nodeEnv });
});

// Background price-alert sweep. Unref'd so it never keeps the process alive on
// its own, and cleared on shutdown.
let alertTimer = null;
if (alertStore && config.alertsCheckIntervalMs > 0) {
  alertTimer = setInterval(() => {
    engine.checkAlerts()
      .then((summary) => { if (summary.triggered > 0) logger.info('Alerts triggered', summary); })
      .catch((err) => logger.warn('Alert sweep failed', { error: err.message }));
  }, config.alertsCheckIntervalMs);
  alertTimer.unref?.();
}

function loadOpenapiSpec(log) {
  try {
    return readFileSync(new URL('./docs/openapi.yaml', import.meta.url), 'utf8');
  } catch (err) {
    log.warn('OpenAPI spec could not be loaded', { error: err.message });
    return null;
  }
}

function loadPage(path, log) {
  try {
    return readFileSync(new URL(path, import.meta.url), 'utf8');
  } catch (err) {
    log.warn('Page could not be loaded', { path, error: err.message });
    return null;
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    logger.info('Shutdown signal received', { signal });
    if (alertTimer) clearInterval(alertTimer);
    server.close(() => {
      logger.info('Server stopped');
      process.exit(0);
    });
  });
}
