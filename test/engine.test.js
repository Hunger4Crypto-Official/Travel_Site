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

test('TravelEngine returns a friendly message when nothing matches', async () => {
  const engine = new TravelEngine({ providers: [new AirportInfoProvider()] });
  const result = await engine.search('airports', { code: 'ZZZ' });
  assert.equal(result.count, 0);
  assert.equal(result.message, 'No offers matched your query.');
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
  async search() { return this._offers; }
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
