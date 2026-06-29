import test from 'node:test';
import assert from 'node:assert/strict';
import { TravelEngine } from '../src/engine/travelEngine.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { BaseProvider } from '../src/providers/baseProvider.js';
import { rankOffers } from '../src/engine/ranking.js';
import { stableCacheKey, validateQuery } from '../src/engine/queryValidation.js';
import { MemoryCache } from '../src/utils/cache.js';

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

test('TravelEngine exposes readiness with provider health', () => {
  const engine = new TravelEngine({ providers: [new MockProvider({ name: 'demo' })] });
  const readiness = engine.readiness();

  assert.equal(readiness.ok, true);
  assert.deepEqual(readiness.providers[0].supports, ['flights', 'hotels', 'cars']);
});
