import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchJson, fetchText, HttpError } from '../src/utils/httpClient.js';
import { CurrencyConverter } from '../src/utils/currency.js';
import { createProviders } from '../src/providers/index.js';
import { jsonResponse, errorResponse, stubFetch, rejectingFetch, abortingFetch } from './helpers/fakeFetch.js';

// ---- httpClient ------------------------------------------------------------

test('fetchJson parses a JSON body and returns null for an empty body', async () => {
  assert.deepEqual(await fetchJson('https://x', { fetchImpl: stubFetch(jsonResponse({ a: 1 })) }), { a: 1 });
  assert.equal(await fetchJson('https://x', { fetchImpl: stubFetch(jsonResponse('')) }), null);
});

test('fetchJson throws HttpError on invalid JSON', async () => {
  await assert.rejects(
    () => fetchJson('https://x', { fetchImpl: stubFetch(jsonResponse('{not json')) }),
    (err) => err instanceof HttpError && /non-JSON/.test(err.message)
  );
});

test('fetchText maps non-OK responses to HttpError carrying the status', async () => {
  await assert.rejects(
    () => fetchText('https://x', { fetchImpl: stubFetch(errorResponse(503)) }),
    (err) => err instanceof HttpError && err.statusCode === 503
  );
});

test('fetchText maps network failures and aborts to HttpError', async () => {
  await assert.rejects(
    () => fetchText('https://x', { fetchImpl: rejectingFetch() }),
    (err) => err instanceof HttpError && err.statusCode === 502
  );
  await assert.rejects(
    () => fetchText('https://x', { fetchImpl: abortingFetch(), timeoutMs: 5 }),
    (err) => err instanceof HttpError && err.statusCode === 504
  );
});

test('fetchText requires a usable fetch implementation', async () => {
  await assert.rejects(
    () => fetchText('https://x', { fetchImpl: null }),
    (err) => err instanceof HttpError && err.statusCode === 500
  );
});

test('fetchText enforces a maximum response size', async () => {
  const big = stubFetch(jsonResponse('x'.repeat(50)));
  await assert.rejects(
    () => fetchText('https://x', { fetchImpl: big, maxBytes: 10 }),
    (err) => err instanceof HttpError && /maximum allowed size/.test(err.message)
  );
});

// ---- CurrencyConverter -----------------------------------------------------

test('CurrencyConverter converts via the base currency using seeded rates', () => {
  const converter = new CurrencyConverter({ base: 'USD', rates: { EUR: 0.5, GBP: 0.8 }, now: () => 0 });
  assert.equal(converter.convert(100, 'EUR', 'USD'), 200); // 100 EUR / 0.5 = 200 USD
  assert.equal(converter.convert(100, 'USD', 'EUR'), 50);
  assert.equal(converter.convert(100, 'USD', 'USD'), 100);
  assert.equal(converter.convert(80, 'GBP', 'EUR'), 50); // 80/0.8=100 USD -> *0.5
});

test('CurrencyConverter returns null when a rate is missing or amount invalid', () => {
  const converter = new CurrencyConverter({ base: 'USD', rates: { EUR: 0.5 }, now: () => 0 });
  assert.equal(converter.convert(100, 'JPY', 'USD'), null);
  assert.equal(converter.convert('abc', 'EUR', 'USD'), null);
  const empty = new CurrencyConverter({ base: 'USD', now: () => 0 });
  assert.equal(empty.convert(100, 'EUR', 'USD'), null);
});

test('CurrencyConverter fetches and caches rates with a TTL', async () => {
  let clock = 0;
  const fetchImpl = stubFetch(jsonResponse({ base: 'USD', rates: { EUR: 0.5 } }));
  const converter = new CurrencyConverter({ base: 'USD', fetchImpl, ttlMs: 1000, now: () => clock });

  await converter.ensureRates();
  assert.equal(converter.convert(100, 'EUR', 'USD'), 200);
  clock = 500;
  await converter.ensureRates(); // still fresh -> no second fetch
  assert.equal(fetchImpl.calls.length, 1);
  clock = 2000;
  await converter.ensureRates(); // stale -> refetch
  assert.equal(fetchImpl.calls.length, 2);
});

test('CurrencyConverter throws on malformed rate payloads', async () => {
  const converter = new CurrencyConverter({ base: 'USD', fetchImpl: stubFetch(jsonResponse({})), now: () => 0 });
  await assert.rejects(() => converter.ensureRates(), /malformed/);
});

// ---- provider registry -----------------------------------------------------

test('createProviders registers only no-key providers by default', () => {
  const names = createProviders({ providerTimeoutMs: 1000 }).map((p) => p.name);
  assert.deepEqual(names, ['the-travel-club-demo', 'iata-icao-reference', 'opensky-network', 'adsb-lol', 'airplanes-live']);
});

test('createProviders adds key-based providers only when credentials are present', () => {
  const names = createProviders({
    amadeusClientId: 'a', amadeusClientSecret: 'b',
    hotelbedsApiKey: 'k', hotelbedsSecret: 's',
    aeroDataBoxKey: 'r',
    travelpayoutsToken: 't'
  }).map((p) => p.name);

  assert.ok(names.includes('amadeus'));
  assert.ok(names.includes('hotelbeds'));
  assert.ok(names.includes('aerodatabox'));
  assert.ok(names.includes('travelpayouts'));
});

test('createProviders honors disable flags', () => {
  const names = createProviders({
    demoProviderEnabled: false,
    airportProviderEnabled: false,
    openSkyEnabled: false,
    adsbEnabled: false
  }).map((p) => p.name);
  assert.deepEqual(names, []);
});
