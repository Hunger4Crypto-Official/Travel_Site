import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchJson, fetchText, HttpError } from '../src/utils/httpClient.js';
import { CurrencyConverter } from '../src/utils/currency.js';
import { createProviders } from '../src/providers/index.js';
import { jsonResponse, errorResponse, stubFetch, rejectingFetch, abortingFetch, streamResponse } from './helpers/fakeFetch.js';

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

test('fetchText enforces a maximum response size (text fallback path)', async () => {
  const big = stubFetch(jsonResponse('x'.repeat(50)));
  await assert.rejects(
    () => fetchText('https://x', { fetchImpl: big, maxBytes: 10 }),
    (err) => err instanceof HttpError && /maximum allowed size/.test(err.message)
  );
});

test('fetchText rejects early on an oversized Content-Length header', async () => {
  const fetchImpl = stubFetch(streamResponse(['{}'], { contentLength: 9999 }));
  await assert.rejects(
    () => fetchText('https://x', { fetchImpl, maxBytes: 100 }),
    (err) => err instanceof HttpError && /maximum allowed size/.test(err.message)
  );
});

test('fetchText streams within the cap and aborts a stream that exceeds it', async () => {
  const ok = stubFetch(streamResponse(['{"a"', ':1}']));
  assert.deepEqual(await fetchJson('https://x', { fetchImpl: ok }), { a: 1 });

  const tooBig = stubFetch(streamResponse(['12345', '67890', 'abcde'], {}));
  await assert.rejects(
    () => fetchText('https://x', { fetchImpl: tooBig, maxBytes: 8 }),
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

test('CurrencyConverter defaults its clock and defaults from/to to the base currency', () => {
  // No `now` option -> the default clock is installed.
  const converter = new CurrencyConverter({ base: 'USD', rates: { EUR: 0.5 } });
  // Omitting from/to makes both sides the base currency, so the amount is unchanged.
  assert.equal(converter.convert(100), 100);
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

test('CurrencyConverter collapses concurrent refreshes into one request', async () => {
  let resolveFetch;
  const fetchImpl = stubFetch(() => new Promise((resolve) => { resolveFetch = () => resolve(jsonResponse({ rates: { EUR: 0.5 } })); }));
  const converter = new CurrencyConverter({ base: 'USD', fetchImpl, now: () => 0 });

  const a = converter.ensureRates();
  const b = converter.ensureRates(); // shares the in-flight request
  resolveFetch();
  await Promise.all([a, b]);
  assert.equal(fetchImpl.calls.length, 1);
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
    hotelbedsApiKey: 'k', hotelbedsSecret: 's',
    aeroDataBoxKey: 'r',
    travelpayoutsToken: 't',
    skyScrapperKey: 'r',
    bookingComKey: 'r',
    carRentalKey: 'r'
  }).map((p) => p.name);

  assert.ok(names.includes('hotelbeds'));
  assert.ok(names.includes('aerodatabox'));
  assert.ok(names.includes('travelpayouts'));
  assert.ok(names.includes('sky-scrapper'));
  assert.ok(names.includes('booking-com'));
  assert.ok(names.includes('car-rental'));
});

test('createProviders keeps demo prices out of verticals a real provider covers', () => {
  const providers = createProviders({ hotelbedsApiKey: 'k', hotelbedsSecret: 's', travelpayoutsToken: 't' });
  const demo = providers.find((p) => p.name === 'the-travel-club-demo');
  assert.equal(demo.supports('flights'), false); // Travelpayouts covers flights
  assert.equal(demo.supports('hotels'), false);  // Hotelbeds covers hotels
  assert.equal(demo.supports('cars'), true);     // no real car provider -> demo still serves cars
});

test('createProviders excludes demo verticals for the RapidAPI providers too', () => {
  const demo = createProviders({ skyScrapperKey: 'r', bookingComKey: 'r', carRentalKey: 'r' })
    .find((p) => p.name === 'the-travel-club-demo');
  assert.equal(demo.supports('flights'), false); // Sky-Scrapper covers flights
  assert.equal(demo.supports('hotels'), false);  // Booking.com covers hotels
  assert.equal(demo.supports('cars'), false);    // car-rental covers cars
});

test('demo serves all its verticals when no real provider is configured', () => {
  const demo = createProviders({}).find((p) => p.name === 'the-travel-club-demo');
  assert.deepEqual(demo.supportedTypes(), ['flights', 'hotels', 'cars']);
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
