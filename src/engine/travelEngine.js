import { rankOffers } from './ranking.js';
import { stableCacheKey, validateQuery } from './queryValidation.js';
import { ProviderCircuitBreaker } from './providerCircuitBreaker.js';
import { MemoryCache } from '../utils/cache.js';
import { KeyedRateLimiter } from '../utils/rateLimit.js';
import { MetricsRegistry } from '../observability/metrics.js';

export class TravelEngine {
  constructor({
    providers = [],
    cache = new MemoryCache(),
    limiter = new KeyedRateLimiter(),
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

  async search(type, query = {}, context = {}) {
    // Rate limit per client before doing validation/aggregation work so abusive
    // traffic is shed as early and cheaply as possible.
    const clientKey = context.clientKey || 'global';
    if (!this.limiter.consume(clientKey)) {
      this.metrics.increment('search.rate_limited', { type });
      const err = new Error('Rate limit exceeded');
      err.statusCode = 429;
      err.retryAfter = typeof this.limiter.retryAfterSeconds === 'function' ? this.limiter.retryAfterSeconds() : 60;
      err.publicDetails = { retryAfter: err.retryAfter };
      throw err;
    }

    const validatedQuery = validateQuery(type, query, { maxQueryLength: this.maxQueryLength });
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
    const ranked = rankOffers(normalizedOffers, { sort: query.sort });

    const limit = clampLimit(query.limit);
    const offers = limit ? ranked.slice(0, limit) : ranked;

    const summary = summarizePrices(ranked);

    return {
      query,
      sort: query.sort || 'price',
      count: offers.length,
      total: ranked.length,
      currency: summary.currency,
      priceComparable: summary.priceComparable,
      cheapest: summary.cheapest,
      bestByProvider: summary.bestByProvider,
      offers,
      providers: allResults.map(({ provider, error }) => ({ provider, status: error ? 'error' : 'success', error })),
      ...(message(ranked.length, summary.priceComparable))
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

    const searchPromise = provider.search(type, query);
    // If the timeout wins the race, the provider promise may still settle later.
    // Attach a no-op handler so a late rejection is never an unhandled rejection.
    searchPromise.catch(() => {});

    try {
      const startedAt = Date.now();
      const offers = await Promise.race([searchPromise, timeoutPromise]);
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

function clampLimit(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(n, 50);
}

// Builds the cheapest-price summary independently of the display sort, and
// reports whether the offers can be compared on price directly (single currency).
function summarizePrices(ranked) {
  const priced = ranked.filter((offer) => offer.price && offer.price.amount !== null && offer.price.amount !== undefined);
  const currencies = new Set(priced.map((offer) => offer.price.currency));
  const priceComparable = currencies.size <= 1;
  const byPrice = [...priced].sort((a, b) => a.price.amount - b.price.amount);

  const bestByProvider = [];
  const seen = new Set();
  for (const offer of byPrice) {
    if (seen.has(offer.provider)) continue;
    seen.add(offer.provider);
    bestByProvider.push({ provider: offer.provider, offerId: offer.id, price: offer.price });
  }

  const cheapest = byPrice[0]
    ? { offerId: byPrice[0].id, provider: byPrice[0].provider, price: byPrice[0].price }
    : null;

  return {
    currency: currencies.size === 1 ? [...currencies][0] : null,
    priceComparable,
    cheapest,
    bestByProvider
  };
}

function message(rankedCount, priceComparable) {
  if (rankedCount === 0) return { message: 'No offers matched your query.' };
  if (!priceComparable) {
    return { message: 'Offers span multiple currencies; enable currency conversion (CURRENCY_CONVERSION_ENABLED) for a directly comparable lowest price.' };
  }
  return {};
}
