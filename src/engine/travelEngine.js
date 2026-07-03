import { rankOffers } from './ranking.js';
import { comparableAmount } from './normalizers.js';
import { dedupeOffers } from './dedupe.js';
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
      : { provider: result.reason?.provider || 'unknown', offers: [], error: result.reason?.category || classifyProviderError(result.reason) });

    const skippedProviders = this.providers
      .filter((provider) => provider.ready && provider.supports(type) && !this.circuitBreaker.canCall(provider.name))
      .map((provider) => ({ provider: provider.name, offers: [], error: 'unavailable' }));

    const allResults = [...providerResults, ...skippedProviders];
    const rawOffers = allResults.flatMap((result) => result.offers);
    const normalizedOffers = await this.applyCurrency(rawOffers);

    // Collapse the same product from multiple providers, then rank the survivors.
    const deduped = dedupeOffers(normalizedOffers);
    const ranked = rankOffers(deduped, { sort: query.sort });

    const limit = clampLimit(query.limit);
    const offers = limit ? ranked.slice(0, limit) : ranked;

    // Summaries are computed over every offer (pre-dedup) so each provider's best
    // price is represented even when it was merged into another offer's alternatives.
    const summary = summarizePrices(normalizedOffers);

    const attempted = allResults.length;
    const errored = allResults.filter((result) => result.error).length;

    return {
      query,
      sort: query.sort || 'price',
      count: offers.length,
      total: ranked.length,
      currency: summary.currency,
      priceComparable: summary.priceComparable,
      freshness: summary.freshness,
      cheapest: summary.cheapest,
      bestByProvider: summary.bestByProvider,
      offers,
      providers: allResults.map(({ provider, error }) => (
        error ? { provider, status: 'error', error } : { provider, status: 'success' }
      )),
      ...(buildMessage(type, ranked.length, summary, { attempted, errored }))
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
      const convert = (v) => this.currencyConverter.convert(v, original.currency, this.baseCurrency);
      const amount = convert(original.amount);
      if (amount === null) return offer; // can't convert -> keep original untouched
      // amount converted, so total/base (same currency pair) convert too; only
      // their presence needs guarding, not the conversion result.
      const total = original.total !== undefined && original.total !== null ? convert(original.total) : amount;
      return {
        ...offer,
        price: {
          amount: roundMoney(amount),
          total: roundMoney(total),
          currency: this.baseCurrency,
          base: original.base !== null && original.base !== undefined ? roundMoney(convert(original.base)) : null,
          estimated: Boolean(original.estimated),
          original
        }
      };
    });
  }

  async searchProvider(provider, type, query) {
    let timeout;
    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        const err = new Error(`Provider timed out after ${provider.timeoutMs}ms`);
        err.provider = provider.name;
        err.category = 'timeout';
        reject(err);
      }, provider.timeoutMs);
    });

    const searchPromise = provider.search(type, query);
    // If the timeout wins the race, the provider promise may still settle later.
    // Attach a no-op handler so a late rejection is never an unhandled rejection.
    searchPromise.catch(() => {});

    // The race settles as soon as the search resolves/rejects or the timer
    // fires; clear the timer on both outcomes so a late timer can never reject
    // an already-settled race (which would be an unhandled rejection).
    try {
      const startedAt = Date.now();
      const offers = await Promise.race([searchPromise, timeoutPromise]);
      clearTimeout(timeout);
      this.circuitBreaker.recordSuccess(provider.name);
      this.metrics.increment('provider.success', { provider: provider.name, type });
      this.metrics.observe('provider.duration_ms', Date.now() - startedAt, { provider: provider.name, type });
      return { provider: provider.name, offers };
    } catch (err) {
      clearTimeout(timeout);
      this.circuitBreaker.recordFailure(provider.name);
      this.metrics.increment('provider.failure', { provider: provider.name, type });
      this.logger?.warn('Provider search failed', { provider: provider.name, type, error: err.message });
      err.provider = provider.name;
      throw err;
    }
  }
}

function roundMoney(amount) {
  return Math.round(amount * 100) / 100;
}

function clampLimit(value) {
  // validateQuery has already guaranteed a 1-50 integer when limit is present.
  if (value === undefined || value === null || value === '') return null;
  return Number.parseInt(value, 10);
}

// Maps a provider failure to a coarse, non-sensitive category so integrators can
// react (retry a timeout, fix a key on auth) without any internal detail leaking.
function classifyProviderError(err) {
  const status = err?.statusCode ?? err?.status;
  if (err?.name === 'AbortError' || /timed out/i.test(err?.message || '')) return 'timeout';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limited';
  return 'unavailable';
}

// Builds the cheapest-price summary independently of the display sort, and
// reports whether the lowest price is genuinely trustworthy: a single currency
// AND every priced offer exposes a verified all-in total (not an estimate).
function summarizePrices(offers) {
  const priced = offers.filter((offer) => comparableAmount(offer) !== null);
  const currencies = new Set(priced.map((offer) => offer.price.currency));
  const sameCurrency = currencies.size <= 1;
  const anyEstimated = priced.some((offer) => offer.price?.estimated === true);
  const anyDemo = offers.some((offer) => offer.freshness === 'demo');
  const priceComparable = priced.length > 0 && sameCurrency && !anyEstimated;
  const byPrice = [...priced].sort((a, b) => comparableAmount(a) - comparableAmount(b));

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
    sameCurrency,
    anyEstimated,
    anyDemo,
    freshness: summarizeFreshness(offers),
    cheapest,
    bestByProvider
  };
}

// One freshness label for the whole result: a single shared value when every
// offer agrees (live/cached/demo), otherwise `mixed`. Never claims `live` unless
// every offer really is live.
function summarizeFreshness(offers) {
  const values = new Set(offers.map((offer) => offer.freshness || 'unknown'));
  if (values.size === 0) return null;
  if (values.size === 1) return [...values][0];
  return 'mixed';
}

function buildMessage(type, rankedCount, summary, { attempted, errored }) {
  if (rankedCount === 0) {
    if (attempted === 0) {
      return { message: 'No providers are currently available for this search.' };
    }
    if (errored === attempted) {
      return { message: 'Travel data sources are temporarily unavailable. Please try again shortly.' };
    }
    if (type === 'airports') {
      return { message: 'No matching airport was found for that code.' };
    }
    if (errored > 0) {
      return { message: 'No offers matched your query. Some sources were unavailable, so more results may exist.' };
    }
    return { message: 'No offers matched your query.' };
  }

  if (!summary.sameCurrency) {
    return { message: 'Offers span multiple currencies; enable currency conversion (CURRENCY_CONVERSION_ENABLED) for a directly comparable lowest price.' };
  }

  const notes = [];
  if (summary.anyDemo) {
    notes.push('Results include demo placeholder data because no live provider is configured for this search; these are not real quotes.');
  } else if (summary.anyEstimated) {
    notes.push('Some prices are estimates or cached fares without full taxes/fees; the lowest price may not be a final all-in total.');
  }
  if (errored > 0) {
    notes.push('Some sources were unavailable, so more options may exist.');
  }
  return notes.length ? { message: notes.join(' ') } : {};
}
