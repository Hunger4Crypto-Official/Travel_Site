import { rankOffers } from './ranking.js';
import { comparableAmount } from './normalizers.js';
import { dedupeOffers } from './dedupe.js';
import { stableCacheKey, validateQuery } from './queryValidation.js';
import { ProviderCircuitBreaker } from './providerCircuitBreaker.js';
import { MemoryCache } from '../utils/cache.js';
import { KeyedRateLimiter } from '../utils/rateLimit.js';
import { MetricsRegistry } from '../observability/metrics.js';
import { priceHistoryKey } from '../utils/priceHistory.js';

// Published on every search response: ranking is cheapest-comparable-total
// first and placement can never be bought. See /v1/trust.
const RANKING_POLICY = Object.freeze({ basis: 'comparable all-in total', paidPlacement: false });

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
    priceHistory = null,
    alertStore = null,
    notifier = null,
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
    this.priceHistory = priceHistory;
    this.alertStore = alertStore;
    this.notifier = notifier;
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
    this.consumeRateLimit(type, context);
    const validatedQuery = validateQuery(type, query, { maxQueryLength: this.maxQueryLength });
    return this.runCached(type, validatedQuery);
  }

  consumeRateLimit(type, context = {}) {
    const clientKey = context.clientKey || 'global';
    if (!this.limiter.consume(clientKey)) {
      this.metrics.increment('search.rate_limited', { type });
      const err = new Error('Rate limit exceeded');
      err.statusCode = 429;
      err.retryAfter = typeof this.limiter.retryAfterSeconds === 'function' ? this.limiter.retryAfterSeconds() : 60;
      err.publicDetails = { retryAfter: err.retryAfter };
      throw err;
    }
  }

  // Cache-aware execution shared by search() and the flexible-date calendar, so
  // a date already fetched by a normal search is reused by the calendar and vice
  // versa. Assumes the query is already validated.
  async runCached(type, validatedQuery) {
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

  // Flexible-date price calendar: fans a flight search across date +/- flexDays
  // (clamped to today onward) and returns the cheapest comparable total per day
  // so a traveler can see whether a nearby date is cheaper. One rate-limit token
  // covers the whole calendar; per-day results are cache-shared with search().
  async flexibleSearch(type, query = {}, context = {}, { flexDays } = {}) {
    this.consumeRateLimit(type, context);
    const base = validateQuery(type, query, { maxQueryLength: this.maxQueryLength });
    if (!base.date) {
      throw httpError(400, 'A center date is required for a flexible-date calendar', { field: 'date' });
    }
    const flex = clampFlex(flexDays);
    const dates = dateWindow(base.date, flex, Date.now());

    const calendar = [];
    for (const date of dates) {
      const result = await this.runCached(type, { ...base, date });
      const cheapest = result.cheapest
        ? {
          total: result.cheapest.price.total,
          currency: result.cheapest.price.currency,
          provider: result.cheapest.provider,
          estimated: result.cheapest.price.estimated
        }
        : null;
      calendar.push({ date, count: result.count, currency: result.currency, freshness: result.freshness, priceComparable: result.priceComparable, cheapest });
    }

    const priced = calendar.filter((day) => day.cheapest);
    const cheapestDay = priced.reduce((best, day) => (!best || day.cheapest.total < best.cheapest.total ? day : best), null);
    return {
      type,
      query: base,
      flexDays: flex,
      calendar,
      cheapestDate: cheapestDay ? cheapestDay.date : null,
      ...(priced.length === 0 ? { message: 'No priced offers were found on any date in the window.' } : {})
    };
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
    const priceContext = this.recordAndContextualize(type, query, normalizedOffers, summary);

    return {
      query,
      sort: query.sort || 'price',
      count: offers.length,
      total: ranked.length,
      currency: summary.currency,
      priceComparable: summary.priceComparable,
      freshness: summary.freshness,
      ranking: RANKING_POLICY,
      cheapest: summary.cheapest,
      bestByProvider: summary.bestByProvider,
      ...(priceContext ? { priceContext } : {}),
      offers,
      providers: allResults.map(({ provider, error }) => (
        error ? { provider, status: 'error', error } : { provider, status: 'success' }
      )),
      ...(buildMessage(type, ranked.length, summary, { attempted, errored }))
    };
  }

  // Records the cheapest REAL price for this search (never demo data) and, once
  // at least three samples exist for the same key and currency inside the
  // window, returns honest "vs. recent average" context for the response.
  recordAndContextualize(type, query, offers, summary) {
    if (!this.priceHistory || !summary.cheapest) return null;
    const key = priceHistoryKey(type, query);
    if (!key) return null;

    // cheapest is derived from this same offers array (priced offers only), so
    // the lookup always hits and price is always present.
    const cheapestOffer = offers.find((offer) => offer.id === summary.cheapest.offerId);
    const total = summary.cheapest.price.total;
    if (cheapestOffer.freshness === 'demo' || !Number.isFinite(total)) return null;

    const currency = summary.cheapest.price.currency;
    this.priceHistory.record({ type, key, currency, total, provider: summary.cheapest.provider });

    const stats = this.priceHistory.stats({ type, key, currency });
    if (!stats || stats.samples < 3) return null;

    const deltaPercent = Math.round(((total - stats.average) / stats.average) * 100);
    return {
      key,
      windowDays: 30,
      samples: stats.samples,
      average: stats.average,
      lowest: stats.lowest,
      current: total,
      currency,
      deltaPercent,
      position: pricePosition(deltaPercent)
    };
  }

  // Read-side of price memory for GET /v1/prices/history.
  priceHistorySnapshot(type, query = {}) {
    if (!this.priceHistory) {
      throw httpError(404, 'Price history is not enabled', { setting: 'PRICE_HISTORY_ENABLED' });
    }
    if (!['flights', 'hotels', 'cars'].includes(type)) {
      throw httpError(400, 'Invalid type. Expected one of: flights, hotels, cars', { field: 'type', allowed: ['flights', 'hotels', 'cars'] });
    }
    const key = priceHistoryKey(type, query);
    if (!key) {
      const needed = type === 'flights' ? 'from and to' : 'city';
      throw httpError(400, `Missing required query parameter(s) for ${type} history: ${needed}`, { type });
    }

    const latest = this.priceHistory.latestFor(type, key);
    if (!latest) {
      return { type, key, samples: 0, message: 'No price history recorded yet for this search.' };
    }
    const currency = latest.currency;
    const stats = this.priceHistory.stats({ type, key, currency });
    return {
      type,
      key,
      currency,
      windowDays: 30,
      ...stats,
      series: this.priceHistory.series({ type, key, currency })
    };
  }

  // ---- price alerts / saved searches ----------------------------------------
  // A watch is a saved search; with a threshold it is a price alert. Watches are
  // owner-scoped by the authenticated principal (or 'anonymous' in keyless dev).

  createAlert(type, input = {}, context = {}) {
    if (!this.alertStore) throw httpError(404, 'Alerts are not enabled', { setting: 'ALERTS_ENABLED' });
    if (!['flights', 'hotels', 'cars'].includes(type)) {
      throw httpError(400, 'Invalid type. Expected one of: flights, hotels, cars', { field: 'type', allowed: ['flights', 'hotels', 'cars'] });
    }
    const validated = validateQuery(type, input, { maxQueryLength: this.maxQueryLength });
    // validateQuery guarantees the fields priceHistoryKey needs for these types,
    // so the key is always resolvable here.
    const key = priceHistoryKey(type, validated);
    const threshold = parseThreshold(input.threshold);
    const watch = this.alertStore.create({
      owner: ownerOf(context),
      type,
      query: validated,
      key,
      threshold,
      currency: input.currency ? String(input.currency).toUpperCase() : (this.baseCurrency || null),
      notifyUrl: input.notifyUrl ? String(input.notifyUrl) : null
    });
    return publicAlert(watch);
  }

  listAlerts(context = {}) {
    if (!this.alertStore) throw httpError(404, 'Alerts are not enabled', { setting: 'ALERTS_ENABLED' });
    const alerts = this.alertStore.list(ownerOf(context)).map(publicAlert);
    return { alerts, count: alerts.length };
  }

  deleteAlert(id, context = {}) {
    if (!this.alertStore) throw httpError(404, 'Alerts are not enabled', { setting: 'ALERTS_ENABLED' });
    if (!id) throw httpError(400, 'An alert id is required', { field: 'id' });
    if (!this.alertStore.remove(id, ownerOf(context))) throw httpError(404, 'Alert not found', { id });
    return { deleted: true, id };
  }

  // Background sweep: re-run each active watch's search (cache-shared, no rate
  // limit), record the price, and fire a notification the first time the price
  // crosses at/below the threshold. A watch whose query is no longer valid (e.g.
  // its date has passed) is deactivated instead of crashing the sweep.
  async checkAlerts() {
    if (!this.alertStore) return { checked: 0, triggered: 0 };
    const watches = this.alertStore.activeWatches();
    let triggered = 0;
    for (const watch of watches) {
      try {
        const validated = validateQuery(watch.type, watch.query, { maxQueryLength: this.maxQueryLength });
        const result = await this.runCached(watch.type, validated);
        const total = result.cheapest ? result.cheapest.price.total : null;
        const patch = { lastCheckedAt: Date.now(), lastPrice: total };
        const below = total !== null && watch.threshold !== null && total <= watch.threshold;
        if (below && !watch.triggered) {
          patch.triggered = true;
          patch.lastTriggeredAt = Date.now();
          triggered += 1;
          if (this.notifier) this.notifier.notify(watch.notifyUrl, alertPayload(watch, total, result)).catch(() => {});
        } else if (!below && watch.triggered) {
          patch.triggered = false; // reset so it can fire again on the next drop
        }
        this.alertStore.update(watch.id, patch);
      } catch (err) {
        this.alertStore.update(watch.id, { active: false, lastCheckedAt: Date.now(), lastError: err.message });
      }
    }
    return { checked: watches.length, triggered };
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

// A 5% band around the recent average keeps the label honest: tiny wobbles are
// "near average", not breathless "below average!" claims.
function pricePosition(deltaPercent) {
  if (deltaPercent <= -5) return 'below average';
  if (deltaPercent >= 5) return 'above average';
  return 'near average';
}

function httpError(statusCode, message, details) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.details = details;
  return err;
}

function ownerOf(context) {
  return context.principal || 'anonymous';
}

function parseThreshold(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw httpError(400, 'Invalid threshold. Expected a non-negative number', { field: 'threshold' });
  }
  return n;
}

// Public projection of a watch: the notify URL is never echoed back (only
// whether one is configured), so a webhook target cannot leak via list/get.
function publicAlert(watch) {
  return {
    id: watch.id,
    type: watch.type,
    query: watch.query,
    key: watch.key,
    threshold: watch.threshold,
    currency: watch.currency,
    active: watch.active,
    createdAt: watch.createdAt,
    lastPrice: watch.lastPrice,
    triggered: watch.triggered,
    lastTriggeredAt: watch.lastTriggeredAt,
    lastCheckedAt: watch.lastCheckedAt,
    notifyConfigured: Boolean(watch.notifyUrl)
  };
}

function alertPayload(watch, total, result) {
  return {
    event: 'price_alert',
    alertId: watch.id,
    type: watch.type,
    query: watch.query,
    threshold: watch.threshold,
    price: total,
    currency: result.currency,
    cheapest: result.cheapest
  };
}

function clampLimit(value) {
  // validateQuery has already guaranteed a 1-50 integer when limit is present.
  if (value === undefined || value === null || value === '') return null;
  return Number.parseInt(value, 10);
}

// Flex window is a convenience, so an out-of-range value is clamped (1-7 days
// each side) rather than rejected; a missing/garbage value defaults to 3.
function clampFlex(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return 3;
  return Math.min(7, Math.max(1, n));
}

// Dates from centerIso-flex to centerIso+flex, dropping any day before today so
// the calendar never offers a past date (which search would reject anyway).
function dateWindow(centerIso, flex, now) {
  const todayIso = new Date(now).toISOString().slice(0, 10);
  const center = Date.parse(`${centerIso}T00:00:00.000Z`);
  const days = [];
  for (let offset = -flex; offset <= flex; offset += 1) {
    const iso = new Date(center + offset * 86400000).toISOString().slice(0, 10);
    if (iso >= todayIso) days.push(iso);
  }
  return days;
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
