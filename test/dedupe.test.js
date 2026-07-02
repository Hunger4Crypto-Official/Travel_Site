import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalKey, dedupeOffers } from '../src/engine/dedupe.js';
import { TravelEngine } from '../src/engine/travelEngine.js';
import { BaseProvider } from '../src/providers/baseProvider.js';

function offer(over = {}) {
  return {
    id: over.id || 'x', type: over.type || 'flights', provider: over.provider || 'p',
    title: over.title, price: over.price || { amount: 100, total: 100, currency: 'USD' },
    details: over.details || {}, freshness: over.freshness || 'live'
  };
}

test('canonicalKey matches the same flight across providers and ignores unkeyable offers', () => {
  const a = offer({ provider: 'amadeus', details: { segments: [{ carrier: 'AA', number: '100', at: '2026-07-01T08:00', from: 'LAX', to: 'JFK' }] } });
  const b = offer({ provider: 'travelpayouts', details: { airline: 'AA', flightNumber: '100', departureAt: '2026-07-01T08:00:00Z', origin: 'LAX', destination: 'JFK' } });
  assert.equal(canonicalKey(a), canonicalKey(b));
  assert.equal(canonicalKey(offer({ type: 'cars', details: {} })), null);
});

test('dedupeOffers keeps the cheapest and lists the rest as alternatives', () => {
  const segs = [{ carrier: 'AA', number: '100', at: '2026-07-01T08:00', from: 'LAX', to: 'JFK' }];
  const merged = dedupeOffers([
    offer({ id: 'a', provider: 'amadeus', price: { amount: 420, total: 420, currency: 'USD' }, details: { segments: segs } }),
    offer({ id: 't', provider: 'travelpayouts', price: { amount: 399, total: 399, currency: 'USD' }, details: { airline: 'AA', flightNumber: '100', departureAt: '2026-07-01T08:00:00Z', origin: 'LAX', destination: 'JFK' } })
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].provider, 'travelpayouts'); // cheaper wins
  assert.equal(merged[0].alternatives.length, 1);
  assert.equal(merged[0].alternatives[0].provider, 'amadeus');
  assert.equal(merged[0].alternatives[0].price.amount, 420);
});

test('canonicalKey collapses the same hotel and falls back to name without a code', () => {
  const byCode = dedupeOffers([
    offer({ id: 'h1', type: 'hotels', provider: 'hotelbeds', price: { amount: 150, total: 150, currency: 'EUR' }, details: { code: 12345 } }),
    offer({ id: 'h2', type: 'hotels', provider: 'travelpayouts-hotels', price: { amount: 140, total: 140, currency: 'EUR' }, details: { code: 12345 } })
  ]);
  assert.equal(byCode.length, 1);
  assert.equal(byCode[0].provider, 'travelpayouts-hotels'); // cheaper
  assert.equal(byCode[0].alternatives.length, 1);

  assert.equal(
    canonicalKey(offer({ type: 'hotels', provider: 'p', title: 'Grand Hotel', details: { city: 'Paris' } })),
    'hotels:name:grand hotel|paris'
  );
});

test('dedupeOffers passes through offers that cannot be matched', () => {
  const merged = dedupeOffers([offer({ id: 'c', type: 'cars', details: {} })]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].alternatives, []);
});

class StubProvider extends BaseProvider {
  constructor(name, offers) { super({ name }); this._offers = offers; }
  supports() { return true; }
  async search() { return this._offers; }
}

test('TravelEngine dedupes across providers and still reports each provider best price', async () => {
  const segs = [{ carrier: 'AA', number: '100', at: '2026-07-01T08:00', from: 'LAX', to: 'JFK' }];
  const engine = new TravelEngine({ providers: [
    new StubProvider('amadeus', [{ id: 'a', type: 'flights', provider: 'amadeus', title: 'AA100', price: { amount: 420, total: 420, currency: 'USD', estimated: false }, details: { segments: segs }, freshness: 'live' }]),
    new StubProvider('travelpayouts', [{ id: 't', type: 'flights', provider: 'travelpayouts', title: 'AA100', price: { amount: 399, total: 399, currency: 'USD', estimated: true }, details: { airline: 'AA', flightNumber: '100', departureAt: '2026-07-01T08:00:00Z', origin: 'LAX', destination: 'JFK' }, freshness: 'cached' }])
  ] });

  const result = await engine.search('flights', { from: 'LAX', to: 'JFK' });

  assert.equal(result.total, 1); // the two identical flights collapsed to one
  assert.equal(result.offers[0].alternatives.length, 1);
  assert.equal(result.bestByProvider.length, 2); // both providers still represented
  assert.equal(result.freshness, 'mixed'); // one live, one cached
  assert.equal(result.priceComparable, false); // a cached/estimated fare is present
  assert.match(result.message, /estimates or cached/);
});
