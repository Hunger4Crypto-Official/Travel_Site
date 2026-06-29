import { createServer } from 'node:http';
import { brand } from './src/config/brand.js';
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

const config = loadConfig();
const logger = createLogger({ level: config.requestLogLevel });
const currencyConverter = config.currencyConversionEnabled
  ? new CurrencyConverter({ base: config.baseCurrency, ttlMs: config.currencyTtlMs })
  : null;
const engine = new TravelEngine({
  providers: createProviders(config),
  cache: new MemoryCache({ ttlMs: config.cacheTtlMs, maxEntries: config.cacheMaxEntries }),
  limiter: new KeyedRateLimiter({ capacity: config.rateLimitCapacity, refillPerMinute: config.rateLimitRefillPerMinute }),
  metrics: new MetricsRegistry(),
  circuitBreaker: new ProviderCircuitBreaker({ failureThreshold: config.providerFailureThreshold, cooldownMs: config.providerCooldownMs }),
  maxQueryLength: config.maxQueryLength,
  currencyConverter,
  baseCurrency: config.currencyConversionEnabled ? config.baseCurrency : null,
  logger
});

const server = createServer((req, res) => handleRequest(req, res, { engine, brand, logger, config }));

server.listen(config.port, () => {
  logger.info('Server started', { service: brand.name, acronym: brand.acronym, port: config.port, nodeEnv: config.nodeEnv });
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    logger.info('Shutdown signal received', { signal });
    server.close(() => {
      logger.info('Server stopped');
      process.exit(0);
    });
  });
}
