import test from 'node:test';
import assert from 'node:assert/strict';
import { TravelEngine } from '../src/engine/travelEngine.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { AirportInfoProvider } from '../src/providers/airportInfoProvider.js';
import { BaseProvider } from '../src/providers/baseProvider.js';
import { rankOffers } from '../src/engine/ranking.js';
import { stableCacheKey, validateQuery } from '../src/engine/queryValidation.js';
import { MemoryCache } from '../src/utils/cache.js';
import { CurrencyConverter } from '../src/utils/currency.js';
import { TokenBucketRateLimiter, KeyedRateLimiter } from '../src/utils/rateLimit.js';

class ThrowingProvider extends BaseProvider {
  constructor() { super({ name: 'throwing' }); }
  supports(type) { return type === 'flights'; }
  async search() { throw new Error('secret provider failure'); }
}

class CountingProvider extends MockProvider {
  constructor() { super({ name: 'counting' }); this.calls = 0; }
  async search(type, query) { this.calls += 1; return super.search(type, query); }
}

class FailingProvider extends BaseProvider {
  constructor(name, err) { super({ name }); this._err = err; }
  supports(type) { return type === 'flights'; }
  async search() { throw this._err; }
}

test('rankOffers sorts valid prices from lowest to highest by default', () => {
  const ranked = rankOffers([
    { price: { amount: 50 }, score: 100 },
    { price: { amount: 25 }, score: 1 }
  ]);

  assert.equal(ranked[0].price.amount, 25);
});

test('rankOffers can sort by score before price', () => {
  const ranked = rankOffers([
    { price: { amount: 50 }, score: 1 },
    { price: { amount: 75 }, score: 100 }
  ], { sort: 'score' });

  assert.equal(ranked[0].score, 100);
});

test('stableCacheKey is independent of query parameter order and whitespace', () => {
  assert.equal(
    stableCacheKey('flights', { from: ' LAX ', to: 'JFK' }),
    stableCacheKey('flights', { to: 'JFK', from: 'LAX' })
  );
});

test('validateQuery rejects malformed dates and same airport flights', () => {
  assert.throws(() => validateQuery('flights', { from: 'LAX', to: 'JFK', date: '2026-99-99' }), /Invalid date format/);
  assert.throws(() => validateQuery('flights', { from: 'LAX', to: 'LAX' }), /must be different/);
});

test('TravelEngine aggregates and ranks provider offers', async () => {
  const engine = new TravelEngine({ providers: [new MockProvider({ name: 'demo' })] });
  const result = await engine.search('flights', { from: 'LAX', to: 'JFK' });

  assert.equal(result.count, 3);
  assert.equal(result.offers[0].price.amount, 312);
  assert.equal(result.providers[0].status, 'success');
});

test('TravelEngine echoes applied sort, reports total, and supports limit', async () => {
  const engine = new TravelEngine({ providers: [new MockProvider({ name: 'demo' })] });

  const all = await engine.search('flights', { from: 'LAX', to: 'JFK' });
  assert.equal(all.sort, 'price');
  assert.equal(all.total, 3);
  assert.equal(all.count, 3);

  const limited = await engine.search('flights', { from: 'LAX', to: 'JFK', limit: '1' });
  assert.equal(limited.count, 1);
  assert.equal(limited.total, 3); // total reflects all matches before limiting
  assert.equal(limited.offers.length, 1);
});

test('TravelEngine returns an airport-specific message when a code is not found', async () => {
  const engine = new TravelEngine({ providers: [new AirportInfoProvider()] });
  const result = await engine.search('airports', { code: 'ZZZ' });
  assert.equal(result.count, 0);
  assert.equal(result.message, 'No matching airport was found for that code.');
});

test('TravelEngine flags demo placeholder data in freshness and message', async () => {
  const engine = new TravelEngine({ providers: [new MockProvider({ name: 'demo' })] });
  const result = await engine.search('flights', { from: 'LAX', to: 'JFK' });

  assert.equal(result.freshness, 'demo'); // never "live" for placeholder data
  assert.equal(result.offers[0].freshness, 'demo');
  assert.match(result.message, /demo placeholder data/);
});

test('TravelEngine reports temporary unavailability when every provider fails', async () => {
  const engine = new TravelEngine({ providers: [new ThrowingProvider()] });
  const result = await engine.search('flights', { from: 'LAX', to: 'JFK' });

  assert.equal(result.count, 0);
  assert.equal(result.message, 'Travel data sources are temporarily unavailable. Please try again shortly.');
  assert.equal(result.providers[0].status, 'error');
  assert.equal(result.providers[0].error, 'unavailable'); // coarse category, no internals
});

test('TravelEngine reports "no providers available" when none support the type', async () => {
  const engine = new TravelEngine({ providers: [new AirportInfoProvider()] });
  const result = await engine.search('cars', { city: 'Miami' });
  assert.equal(result.count, 0);
  assert.equal(result.message, 'No providers are currently available for this search.');
});

test('TravelEngine notes partial unavailability when some providers fail but others return nothing', async () => {
  // A provider that supports flights but returns no offers, alongside one that throws.
  class EmptyProvider extends BaseProvider {
    constructor() { super({ name: 'empty' }); }
    supports(type) { return type === 'flights'; }
    async search() { return []; }
  }
  const engine = new TravelEngine({ providers: [new EmptyProvider(), new ThrowingProvider()] });
  const result = await engine.search('flights', { from: 'LAX', to: 'JFK' });

  assert.equal(result.count, 0);
  assert.match(result.message, /Some sources were unavailable/);
});

test('TravelEngine categorizes a provider timeout distinctly from other failures', async () => {
  const engine = new TravelEngine({ providers: [new HangingProvider()] });
  const result = await engine.search('flights', { from: 'LAX', to: 'JFK' });
  assert.equal(result.providers.find((p) => p.provider === 'hang').error, 'timeout');
});

test('TravelEngine reports providers skipped by an open circuit as unavailable', async () => {
  const openBreaker = {
    canCall: (name) => name !== 'blocked',
    recordSuccess() {},
    recordFailure() {},
    status() { return { open: true }; }
  };
  class BlockedProvider extends BaseProvider {
    constructor() { super({ name: 'blocked' }); }
    supports(t) { return t === 'flights'; }
    async search() { return []; }
  }
  const engine = new TravelEngine({
    providers: [new MockProvider({ name: 'demo' }), new BlockedProvider()],
    circuitBreaker: openBreaker
  });
  const result = await engine.search('flights', { from: 'LAX', to: 'JFK' });
  const blocked = result.providers.find((p) => p.provider === 'blocked');

  assert.equal(blocked.status, 'error');
  assert.equal(blocked.error, 'unavailable'); // circuit-open is surfaced as unavailable
  assert.equal(result.count, 3); // demo still serves offers
});

test('TravelEngine maps provider failures to coarse, non-sensitive categories', async () => {
  const mk = (props) => Object.assign(new Error('boom'), props);
  const engine = new TravelEngine({
    providers: [
      new FailingProvider('unauth', mk({ statusCode: 401 })),
      new FailingProvider('forbidden', mk({ statusCode: 403 })),
      new FailingProvider('status-fallback', mk({ status: 403 })), // uses .status, not .statusCode
      new FailingProvider('throttled', mk({ statusCode: 429 })),
      new FailingProvider('aborted', mk({ name: 'AbortError' })),
      new FailingProvider('slow', mk({ message: 'Upstream request timed out after 8000ms' })),
      new FailingProvider('blank', new Error('')), // no name, empty message -> default
      new FailingProvider('generic', mk({}))
    ],
    // A logger present during a failure exercises the warn path in searchProvider.
    logger: { warn() {}, info() {} }
  });
  const result = await engine.search('flights', { from: 'LAX', to: 'JFK' });
  const category = (name) => result.providers.find((p) => p.provider === name).error;

  assert.equal(category('unauth'), 'auth');
  assert.equal(category('forbidden'), 'auth');
  assert.equal(category('status-fallback'), 'auth');
  assert.equal(category('throttled'), 'rate_limited');
  assert.equal(category('aborted'), 'timeout');
  assert.equal(category('slow'), 'timeout');
  assert.equal(category('blank'), 'unavailable');
  assert.equal(category('generic'), 'unavailable');
});

test('TravelEngine validates required query parameters', async () => {
  const engine = new TravelEngine({ providers: [new MockProvider({ name: 'demo' })] });

  await assert.rejects(
    () => engine.search('flights', { from: 'LAX' }),
    /Missing required query parameter: to/
  );
});

test('TravelEngine isolates provider failures and returns partial success', async () => {
  const engine = new TravelEngine({ providers: [new MockProvider({ name: 'demo' }), new ThrowingProvider()] });
  const result = await engine.search('flights', { from: 'LAX', to: 'JFK' });

  assert.equal(result.count, 3);
  assert.equal(result.providers.find((provider) => provider.provider === 'throwing').status, 'error');
});

test('TravelEngine caches identical validated searches', async () => {
  const provider = new CountingProvider();
  const engine = new TravelEngine({ providers: [provider], cache: new MemoryCache({ ttlMs: 1000, maxEntries: 10 }) });

  await engine.search('flights', { from: 'LAX', to: 'JFK' });
  await engine.search('flights', { to: 'JFK', from: 'LAX' });

  assert.equal(provider.calls, 1);
});

class HangingProvider extends BaseProvider {
  constructor() { super({ name: 'hang', timeoutMs: 10 }); }
  supports(type) { return type === 'flights'; }
  search() { return new Promise(() => {}); } // never resolves -> must be timed out
}

test('TravelEngine times out a hung provider and still returns other offers', async () => {
  const engine = new TravelEngine({ providers: [new MockProvider({ name: 'demo' }), new HangingProvider()] });
  const result = await engine.search('flights', { from: 'LAX', to: 'JFK' });

  assert.equal(result.count, 3); // the demo provider's offers still come back
  assert.equal(result.providers.find((p) => p.provider === 'hang').status, 'error');
});

class FixedPriceProvider extends BaseProvider {
  constructor(name, offers) { super({ name }); this._offers = offers; }
  supports() { return true; }
  async search() { return this._offers.map((offer) => ({ provider: this.name, ...offer })); }
}

test('TravelEngine converts offer prices to the base currency before ranking', async () => {
  const converter = new CurrencyConverter({ base: 'USD', rates: { EUR: 0.5 }, now: () => 0 });
  const engine = new TravelEngine({
    providers: [new FixedPriceProvider('eur', [
      { id: 'a', type: 'flights', price: { amount: 100, currency: 'EUR' }, score: 1 } // 200 USD
    ]), new FixedPriceProvider('usd', [
      { id: 'b', type: 'flights', price: { amount: 150, currency: 'USD' }, score: 1 } // cheaper once normalized
    ])],
    currencyConverter: converter,
    baseCurrency: 'USD'
  });

  const result = await engine.search('flights', { from: 'LAX', to: 'JFK' });

  assert.equal(result.offers[0].id, 'b'); // 150 USD ranks ahead of 200 USD
  const eurOffer = result.offers.find((o) => o.id === 'a');
  assert.equal(eurOffer.price.amount, 200);
  assert.equal(eurOffer.price.currency, 'USD');
  assert.equal(eurOffer.price.original.currency, 'EUR');

  // After conversion everything is one currency, so the lowest price is trustworthy.
  assert.equal(result.priceComparable, true);
  assert.equal(result.currency, 'USD');
  assert.equal(result.cheapest.offerId, 'b');
  assert.equal(result.cheapest.price.amount, 150);
});

test('TravelEngine converts full price breakdowns and leaves unpriced/unconvertible offers alone', async () => {
  const converter = new CurrencyConverter({ base: 'USD', rates: { EUR: 0.5 }, now: () => 0 });
  const engine = new TravelEngine({
    providers: [new FixedPriceProvider('mix', [
      { id: 'full', type: 'flights', price: { amount: 100, total: 110, base: 90, currency: 'EUR' }, score: 1 },
      { id: 'nullamount', type: 'flights', price: { amount: null, currency: 'EUR' }, score: 1 },
      { id: 'gbp', type: 'flights', price: { amount: 80, currency: 'GBP' }, score: 1 } // no GBP rate -> unconvertible
    ])],
    currencyConverter: converter,
    baseCurrency: 'USD',
    logger: { warn() {}, info() {} }
  });

  const result = await engine.search('flights', { from: 'LAX', to: 'JFK' });
  const byId = Object.fromEntries(result.offers.map((o) => [o.id, o]));

  // Full breakdown converted at 1 EUR = 2 USD (amount, total and base all move).
  assert.equal(byId.full.price.amount, 200);
  assert.equal(byId.full.price.total, 220);
  assert.equal(byId.full.price.base, 180);
  assert.equal(byId.full.price.currency, 'USD');
  // A null-amount offer and an offer with no rate keep their original price.
  assert.equal(byId.nullamount.price.currency, 'EUR');
  assert.equal(byId.gbp.price.currency, 'GBP');
});

test('TravelEngine reports the cheapest offer and the best price per provider', async () => {
  const engine = new TravelEngine({ providers: [
    new FixedPriceProvider('alpha', [
      { id: 'a1', type: 'flights', price: { amount: 300, currency: 'USD' }, score: 1 },
      { id: 'a2', type: 'flights', price: { amount: 250, currency: 'USD' }, score: 1 }
    ]),
    new FixedPriceProvider('beta', [
      { id: 'b1', type: 'flights', price: { amount: 199, currency: 'USD' }, score: 1 }
    ])
  ] });

  const result = await engine.search('flights', { from: 'LAX', to: 'JFK' });

  assert.equal(result.priceComparable, true);
  assert.equal(result.currency, 'USD');
  assert.equal(result.cheapest.price.amount, 199);
  assert.equal(result.cheapest.provider, 'beta');
  assert.equal(result.bestByProvider.find((b) => b.provider === 'alpha').price.amount, 250);
  assert.equal(result.bestByProvider.length, 2);
});

test('TravelEngine flags results that span multiple currencies as not directly comparable', async () => {
  const engine = new TravelEngine({ providers: [
    new FixedPriceProvider('eur', [{ id: 'e', type: 'flights', price: { amount: 180, currency: 'EUR' } }]),
    new FixedPriceProvider('usd', [{ id: 'u', type: 'flights', price: { amount: 200, currency: 'USD' } }])
  ] });

  const result = await engine.search('flights', { from: 'LAX', to: 'JFK' });

  assert.equal(result.priceComparable, false);
  assert.equal(result.currency, null);
  assert.match(result.message, /multiple currencies/);
});

test('TravelEngine keeps original prices when currency rates fail to load', async () => {
  const failing = new CurrencyConverter({ base: 'USD', now: () => 0 });
  failing.ensureRates = async () => { throw new Error('rates down'); };
  const engine = new TravelEngine({
    providers: [new FixedPriceProvider('eur', [{ id: 'a', type: 'flights', price: { amount: 100, currency: 'EUR' } }])],
    currencyConverter: failing,
    baseCurrency: 'USD',
    logger: { warn() {}, info() {} }
  });

  const result = await engine.search('flights', { from: 'LAX', to: 'JFK' });
  assert.equal(result.offers[0].price.currency, 'EUR');
});

test('TravelEngine exposes readiness with provider health', () => {
  const engine = new TravelEngine({ providers: [new MockProvider({ name: 'demo' })] });
  const readiness = engine.readiness();

  assert.equal(readiness.ok, true);
  assert.deepEqual(readiness.providers[0].supports, ['flights', 'hotels', 'cars']);
  // health() is an alias of readiness().
  assert.deepEqual(engine.health(), readiness);
});

test('TravelEngine exposes a metrics snapshot', async () => {
  const engine = new TravelEngine({ providers: [new MockProvider({ name: 'demo' })] });
  await engine.search('flights', { from: 'LAX', to: 'JFK' });
  const snap = engine.metricsSnapshot();
  assert.ok('counters' in snap && 'timings' in snap);
});

test('TravelEngine throws 429 when the rate limiter is exhausted', async () => {
  const engine = new TravelEngine({
    providers: [new MockProvider({ name: 'demo' })],
    limiter: new TokenBucketRateLimiter({ capacity: 0, refillPerMinute: 0 })
  });
  await assert.rejects(
    () => engine.search('flights', { from: 'LAX', to: 'JFK' }),
    (err) => err.statusCode === 429
  );
});

test('TravelEngine rate-limits each client key independently', async () => {
  const engine = new TravelEngine({
    providers: [new MockProvider({ name: 'demo' })],
    limiter: new KeyedRateLimiter({ capacity: 1, refillPerMinute: 0 })
  });

  await engine.search('flights', { from: 'LAX', to: 'JFK' }, { clientKey: 'alice' });
  // alice is now exhausted...
  await assert.rejects(
    () => engine.search('flights', { from: 'LAX', to: 'SFO' }, { clientKey: 'alice' }),
    (err) => err.statusCode === 429
  );
  // ...but bob is unaffected.
  const bob = await engine.search('flights', { from: 'LAX', to: 'JFK' }, { clientKey: 'bob' });
  assert.equal(bob.count, 3);
});
