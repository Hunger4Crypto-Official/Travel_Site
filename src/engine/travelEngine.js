import { rankOffers } from './ranking.js';
import { stableCacheKey, validateQuery } from './queryValidation.js';
import { ProviderCircuitBreaker } from './providerCircuitBreaker.js';
import { MemoryCache } from '../utils/cache.js';
import { TokenBucketRateLimiter } from '../utils/rateLimit.js';
import { MetricsRegistry } from '../observability/metrics.js';

export class TravelEngine {
  constructor({
    providers = [],
    cache = new MemoryCache(),
    limiter = new TokenBucketRateLimiter(),
    metrics = new MetricsRegistry(),
    circuitBreaker = new ProviderCircuitBreaker(),
    maxQueryLength = 120,
    currencyConverter = null,
    baseCurrency = null,
    logger = null
  } = {}) {
    this.providers = providers;
    this.cache = cache;
    this.limiter = limiter;
    this.metrics = metrics;
    this.circuitBreaker = circuitBreaker;
    this.maxQueryLength = maxQueryLength;
    this.currencyConverter = currencyConverter;
    this.baseCurrency = baseCurrency ? baseCurrency.toUpperCase() : null;
    this.logger = logger;
  }

  health() {
    return this.readiness();
  }

  readiness() {
    const providers = this.providers.map((provider) => ({
      ...provider.status(),
      circuit: this.circuitBreaker.status(provider.name)
    }));
    const readyProviders = providers.filter((provider) => provider.ready && !provider.circuit.open);
    return {
      ok: readyProviders.length > 0,
      providers
    };
  }

  metricsSnapshot() {
    return this.metrics.snapshot();
  }

  async search(type, query = {}) {
    const validatedQuery = validateQuery(type, query, { maxQueryLength: this.maxQueryLength });
    if (!this.limiter.consume()) {
      this.metrics.increment('search.rate_limited', { type });
      const err = new Error('Rate limit exceeded');
      err.statusCode = 429;
      throw err;
    }

    const cacheKey = stableCacheKey(type, validatedQuery);
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      this.metrics.increment('search.cache_hit', { type });
      return cached;
    }

    this.metrics.increment('search.cache_miss', { type });
    const startedAt = Date.now();
    const value = await this.executeSearch(type, validatedQuery);
    this.metrics.observe('search.duration_ms', Date.now() - startedAt, { type });
    return this.cache.set(cacheKey, value);
  }

  async executeSearch(type, query) {
    const activeProviders = this.providers.filter((provider) => (
      provider.ready && provider.supports(type) && this.circuitBreaker.canCall(provider.name)
    ));

    const settled = await Promise.allSettled(activeProviders.map((provider) => this.searchProvider(provider, type, query)));

    const providerResults = settled.map((result) => result.status === 'fulfilled'
      ? result.value
      : { provider: result.reason?.provider || 'unknown', offers: [], error: 'Provider failed' });

    const skippedProviders = this.providers
      .filter((provider) => provider.ready && provider.supports(type) && !this.circuitBreaker.canCall(provider.name))
      .map((provider) => ({ provider: provider.name, offers: [], error: 'Provider circuit is open' }));

    const allResults = [...providerResults, ...skippedProviders];
    const rawOffers = allResults.flatMap((result) => result.offers);
    const normalizedOffers = await this.applyCurrency(rawOffers);
    const offers = rankOffers(normalizedOffers, { sort: query.sort });
    return {
      query,
      count: offers.length,
      offers,
      providers: allResults.map(({ provider, error }) => ({ provider, status: error ? 'error' : 'success', error }))
    };
  }

  // Convert every offer's price into the configured base currency so that
  // ranking-by-price compares like for like across providers. On any failure
  // the original prices are kept unchanged.
  async applyCurrency(offers) {
    if (!this.currencyConverter || !this.baseCurrency || offers.length === 0) return offers;
    try {
      await this.currencyConverter.ensureRates();
    } catch (err) {
      this.logger?.warn('Currency rate refresh failed', { error: err.message });
      return offers;
    }

    return offers.map((offer) => {
      const original = offer.price;
      if (!original || original.currency === this.baseCurrency || original.amount === null) return offer;
      const converted = this.currencyConverter.convert(original.amount, original.currency, this.baseCurrency);
      if (converted === null) return offer;
      return {
        ...offer,
        price: { amount: roundMoney(converted), currency: this.baseCurrency, original }
      };
    });
  }

  async searchProvider(provider, type, query) {
    let timeout;
    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        const err = new Error(`Provider timed out after ${provider.timeoutMs}ms`);
        err.provider = provider.name;
        reject(err);
      }, provider.timeoutMs);
    });

    try {
      const startedAt = Date.now();
      const offers = await Promise.race([provider.search(type, query), timeoutPromise]);
      this.circuitBreaker.recordSuccess(provider.name);
      this.metrics.increment('provider.success', { provider: provider.name, type });
      this.metrics.observe('provider.duration_ms', Date.now() - startedAt, { provider: provider.name, type });
      return { provider: provider.name, offers };
    } catch (err) {
      this.circuitBreaker.recordFailure(provider.name);
      this.metrics.increment('provider.failure', { provider: provider.name, type });
      this.logger?.warn('Provider search failed', { provider: provider.name, type, error: err.message });
      err.provider = provider.name;
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function roundMoney(amount) {
  return Math.round(amount * 100) / 100;
}
