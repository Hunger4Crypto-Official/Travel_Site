import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryCache } from '../src/utils/cache.js';
import { MetricsRegistry } from '../src/observability/metrics.js';
import { createLogger } from '../src/observability/logger.js';
import { TokenBucketRateLimiter, KeyedRateLimiter } from '../src/utils/rateLimit.js';
import { ProviderCircuitBreaker } from '../src/engine/providerCircuitBreaker.js';
import { normalizeOffer, normalizePrice } from '../src/engine/normalizers.js';
import { rankOffers } from '../src/engine/ranking.js';
import { BaseProvider } from '../src/providers/baseProvider.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { AdsbProvider } from '../src/providers/adsbProvider.js';
import { AeroDataBoxProvider } from '../src/providers/aeroDataBoxProvider.js';
import { HotelbedsProvider } from '../src/providers/hotelbedsProvider.js';
import { TravelpayoutsProvider } from '../src/providers/travelpayoutsProvider.js';

// ---- MemoryCache -----------------------------------------------------------

test('MemoryCache stores, expires, evicts (LRU), deletes and clears', () => {
  const cache = new MemoryCache({ ttlMs: 1000, maxEntries: 2 });
  assert.equal(cache.get('missing'), undefined);

  cache.set('a', 1);
  assert.equal(cache.get('a'), 1);

  // Expiry via explicit negative ttl.
  cache.set('exp', 9, -1);
  assert.equal(cache.get('exp'), undefined);

  // LRU: touch 'a', then overflow so 'b' (least recently used) is evicted.
  cache.set('a', 1);
  cache.set('b', 2);
  assert.equal(cache.get('a'), 1); // 'a' now most-recently used
  cache.set('c', 3); // capacity 2 exceeded -> evict 'b'
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('c'), 3);

  assert.equal(cache.delete('a'), true);
  cache.clear();
  assert.equal(cache.get('c'), undefined);
});

test('MemoryCache with maxEntries 0 is a no-op store', () => {
  const cache = new MemoryCache({ maxEntries: 0 });
  assert.equal(cache.set('a', 1), 1);
  assert.equal(cache.get('a'), undefined);
});

// ---- MetricsRegistry -------------------------------------------------------

test('MetricsRegistry counts, times and snapshots with labels', () => {
  const metrics = new MetricsRegistry();
  metrics.increment('hits');
  metrics.increment('hits');
  metrics.increment('search', { type: 'flights' });
  metrics.observe('dur', 100, { type: 'flights' });
  metrics.observe('dur', 200, { type: 'flights' });

  const snap = metrics.snapshot();
  assert.equal(snap.counters.hits, 2);
  assert.equal(snap.counters['search{type=flights}'], 1);
  assert.equal(snap.timings['dur{type=flights}'].averageMs, 150);
  assert.equal(snap.timings['dur{type=flights}'].maxMs, 200);
});

// ---- logger ----------------------------------------------------------------

test('logger honors level threshold and redacts secrets', () => {
  const lines = [];
  const sink = { log: (l) => lines.push(l), warn: (l) => lines.push(l), error: (l) => lines.push(l) };
  const logger = createLogger({ level: 'warn', sink });

  logger.debug('skip me');
  logger.info('skip me too');
  logger.warn('kept', { apiKey: 'super-secret', authorization: 'Bearer x', nested: { token: 'abc' }, safe: 'ok' });

  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]);
  assert.equal(record.level, 'warn');
  assert.equal(record.apiKey, '[REDACTED]');
  assert.equal(record.authorization, '[REDACTED]');
  assert.equal(record.nested.token, '[REDACTED]');
  assert.equal(record.safe, 'ok');
});

test('logger falls back to info for an unknown level', () => {
  const lines = [];
  const logger = createLogger({ level: 'nonsense', sink: { log: (l) => lines.push(l), warn() {}, error() {} } });
  logger.info('hello');
  assert.equal(lines.length, 1);
});

// ---- TokenBucketRateLimiter ------------------------------------------------

test('TokenBucketRateLimiter depletes then refills over time', () => {
  const limiter = new TokenBucketRateLimiter({ capacity: 1, refillPerMinute: 60 });
  assert.equal(limiter.consume(), true);
  assert.equal(limiter.consume(), false);
  limiter.updatedAt = Date.now() - 60000; // simulate a minute passing
  assert.equal(limiter.consume(), true);
});

test('TokenBucketRateLimiter coerces a non-numeric token argument to one', () => {
  const limiter = new TokenBucketRateLimiter({ capacity: 1, refillPerMinute: 0 });
  assert.equal(limiter.consume('client-key'), true); // treated as 1 token
  assert.equal(limiter.consume('client-key'), false);
});

test('KeyedRateLimiter isolates clients and bounds tracked keys', () => {
  const limiter = new KeyedRateLimiter({ capacity: 1, refillPerMinute: 0, maxKeys: 2 });
  assert.equal(limiter.consume('a'), true);
  assert.equal(limiter.consume('a'), false); // a is exhausted
  assert.equal(limiter.consume('b'), true);  // b is independent

  // Adding a third key evicts the least-recently-used ('a' was touched before 'b').
  assert.equal(limiter.consume('c'), true);
  assert.equal(limiter.buckets.size, 2);
  assert.equal(limiter.consume('a'), true); // 'a' was evicted -> fresh bucket
});

// ---- ProviderCircuitBreaker ------------------------------------------------

test('ProviderCircuitBreaker opens after the failure threshold and reports status', () => {
  const breaker = new ProviderCircuitBreaker({ failureThreshold: 2, cooldownMs: 50000 });
  assert.equal(breaker.canCall('p'), true);
  breaker.recordFailure('p');
  assert.equal(breaker.status('p').open, false);
  breaker.recordFailure('p');
  assert.equal(breaker.canCall('p'), false);
  assert.equal(breaker.status('p').open, true);
  breaker.recordSuccess('p');
  assert.equal(breaker.canCall('p'), true);
  assert.equal(breaker.status('unknown').failures, 0);
});

// ---- normalizers -----------------------------------------------------------

test('normalizePrice coerces invalid amounts to null', () => {
  assert.deepEqual(normalizePrice('abc'), { amount: null, currency: 'USD' });
  assert.deepEqual(normalizePrice(10, 'EUR'), { amount: 10, currency: 'EUR' });
});

test('normalizeOffer fills defaults and an id when none is given', () => {
  const offer = normalizeOffer({ type: 'flights', provider: 'p', price: 100, title: 't' });
  assert.match(offer.id, /^p-flights-/);
  assert.equal(offer.deepLink, null);
  assert.equal(offer.affiliate, null);
  assert.equal(offer.score, null);

  const full = normalizeOffer({ type: 'flights', provider: 'p', id: 'x', price: 1, title: 't', deepLink: 'http://l', affiliateId: 'aff', score: 5 });
  assert.deepEqual(full.affiliate, { id: 'aff' });
  assert.equal(full.deepLink, 'http://l');
});

// ---- ranking ---------------------------------------------------------------

test('rankOffers handles null prices and score ties', () => {
  const ranked = rankOffers([
    { id: 'noprice', price: null, score: 1 },
    { id: 'cheap', price: { amount: 10 }, score: 1 },
    { id: 'mid', price: { amount: 20 }, score: 9 }
  ]);
  assert.equal(ranked[0].id, 'cheap');
  assert.equal(ranked[2].id, 'noprice'); // missing price sorts last

  const byScore = rankOffers([
    { id: 'a', price: { amount: 10 }, score: 5 },
    { id: 'b', price: { amount: 10 }, score: 9 }
  ], { sort: 'score' });
  assert.equal(byScore[0].id, 'b');
});

// ---- BaseProvider defaults -------------------------------------------------

test('BaseProvider exposes safe defaults', async () => {
  const provider = new BaseProvider({ name: 'base', enabled: false });
  assert.equal(provider.ready, false);
  assert.equal(provider.supports('flights'), false);
  assert.deepEqual(await provider.search(), []);
  assert.deepEqual(provider.status().supports, []);
});

test('MockProvider no longer fabricates airports or tracking', () => {
  const mock = new MockProvider({ name: 'demo' });
  assert.equal(mock.supports('airports'), false);
  assert.equal(mock.supports('tracking'), false);
  assert.deepEqual(mock.status().supports, ['flights', 'hotels', 'cars']);
});

// ---- provider status() + non-vertical short-circuits -----------------------

test('providers report status and ignore unsupported verticals without calling out', async () => {
  const failFetch = () => { throw new Error('should not be called'); };

  const adsb = new AdsbProvider({ name: 'adsb-lol', baseUrl: 'https://x', fetchImpl: failFetch });
  assert.equal(adsb.status().baseUrl, 'https://x');
  assert.equal(adsb.supports('tracking'), true);
  assert.equal(adsb.supports('flights'), false);
  assert.deepEqual(await adsb.search('flights', {}), []);

  const adb = new AeroDataBoxProvider({ fetchImpl: failFetch });
  assert.equal(adb.status().configured, false);
  assert.equal(adb.supports('airports'), true);
  assert.equal(adb.supports('flights'), false);
  assert.deepEqual(await adb.search('flights', {}), []);

  const hb = new HotelbedsProvider({ fetchImpl: failFetch });
  assert.equal(hb.status().configured, false);
  assert.equal(hb.supports('hotels'), true);
  assert.equal(hb.supports('flights'), false);
  assert.deepEqual(await hb.search('flights', {}), []);

  const tp = new TravelpayoutsProvider({ fetchImpl: failFetch });
  assert.equal(tp.status().configured, false);
  assert.equal(tp.supports('flights'), true);
  assert.equal(tp.supports('hotels'), false);
  assert.deepEqual(await tp.search('hotels', {}), []);
});
