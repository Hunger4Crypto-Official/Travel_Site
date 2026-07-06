import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { HotelbedsProvider } from '../src/providers/hotelbedsProvider.js';
import { AeroDataBoxProvider } from '../src/providers/aeroDataBoxProvider.js';
import { TravelpayoutsProvider } from '../src/providers/travelpayoutsProvider.js';
import { jsonResponse, stubFetch } from './helpers/fakeFetch.js';

// ---- Hotelbeds -------------------------------------------------------------

test('HotelbedsProvider signs requests and maps availability', async () => {
  const fetchImpl = stubFetch(jsonResponse({
    hotels: { hotels: [{ code: 123, name: 'Test Resort', categoryName: '4 STARS', currency: 'EUR', minRate: '150.00', destinationName: 'Palma', rooms: [{}, {}] }] }
  }));
  const provider = new HotelbedsProvider({ apiKey: 'KEY', secret: 'SECRET', fetchImpl, now: () => 1_000_000 });

  const offers = await provider.search('hotels', { cityCode: 'PMI', checkin: '2026-07-01', checkout: '2026-07-05', rooms: '1', adults: '2' });

  assert.equal(offers.length, 1);
  assert.equal(offers[0].price.amount, 150);
  assert.equal(offers[0].price.currency, 'EUR');
  assert.equal(offers[0].details.category, '4 STARS');
  assert.equal(offers[0].score, 80);

  const expectedSig = createHash('sha256').update(`KEYSECRET${Math.floor(1_000_000 / 1000)}`).digest('hex');
  assert.equal(fetchImpl.calls[0].options.headers['X-Signature'], expectedSig);
  assert.equal(fetchImpl.calls[0].options.headers['Api-key'], 'KEY');
  const body = JSON.parse(fetchImpl.calls[0].options.body);
  assert.equal(body.destination.code, 'PMI');
  assert.equal(body.occupancies[0].adults, 2);
});

test('HotelbedsProvider returns [] without a valid city code and is unconfigured-safe', async () => {
  const fetchImpl = stubFetch(jsonResponse({}));
  const provider = new HotelbedsProvider({ apiKey: 'KEY', secret: 'SECRET', fetchImpl });
  assert.deepEqual(await provider.search('hotels', { city: 'Palma' }), []);
  assert.equal(fetchImpl.calls.length, 0);

  const unconfigured = new HotelbedsProvider({});
  assert.equal(unconfigured.ready, false);
});

test('HotelbedsProvider emits a deep link only when the payload carries a URL, with the affiliate marker', async () => {
  const fetchImpl = stubFetch(jsonResponse({ hotels: { hotels: [
    { code: 1, name: 'A', minRate: '100', url: 'https://book.hotelbeds.com/hotel/1' },       // no query -> '?'
    { code: 2, name: 'B', minRate: '120', url: 'https://book.hotelbeds.com/hotel/2?lang=en' }, // query -> '&'
    { code: 3, name: 'C', minRate: '130' }                                                    // no url -> null
  ] } }));
  const provider = new HotelbedsProvider({ apiKey: 'K', secret: 'S', affiliateId: 'aff', fetchImpl, now: () => 0 });
  const offers = await provider.search('hotels', { cityCode: 'PMI', checkin: '2026-07-01', checkout: '2026-07-05' });
  assert.equal(offers[0].deepLink, 'https://book.hotelbeds.com/hotel/1?aid=aff');
  assert.equal(offers[1].deepLink, 'https://book.hotelbeds.com/hotel/2?lang=en&aid=aff');
  assert.equal(offers[2].deepLink, null);
});

test('HotelbedsProvider leaves a payload URL unmarked when no affiliate is configured', async () => {
  const fetchImpl = stubFetch(jsonResponse({ hotels: { hotels: [{ code: 4, name: 'D', minRate: '90', url: 'https://book.hotelbeds.com/hotel/4' }] } }));
  const provider = new HotelbedsProvider({ apiKey: 'K', secret: 'S', fetchImpl, now: () => 0 });
  const offers = await provider.search('hotels', { cityCode: 'PMI', checkin: '2026-07-01', checkout: '2026-07-05' });
  assert.equal(offers[0].deepLink, 'https://book.hotelbeds.com/hotel/4');
});

// ---- AeroDataBox -----------------------------------------------------------

test('AeroDataBoxProvider looks up airports and sends RapidAPI headers', async () => {
  const fetchImpl = stubFetch(jsonResponse({
    iata: 'LAX', icao: 'KLAX', fullName: 'Los Angeles Intl', municipalityName: 'Los Angeles',
    countryCode: 'US', location: { lat: 33.9, lon: -118.4 }, timeZone: 'America/Los_Angeles', elevation: { feet: 125 }
  }));
  const provider = new AeroDataBoxProvider({ apiKey: 'RKEY', fetchImpl });

  const offers = await provider.search('airports', { code: 'lax' });

  assert.equal(offers.length, 1);
  assert.equal(offers[0].details.country, 'US'); // mapped from countryCode
  assert.equal(offers[0].details.elevationFt, 125);
  assert.match(fetchImpl.calls[0].url, /\/airports\/iata\/LAX$/);
  assert.equal(fetchImpl.calls[0].options.headers['X-RapidAPI-Key'], 'RKEY');
});

test('AeroDataBoxProvider uses the icao path for 4-letter codes and skips invalid codes', async () => {
  const fetchImpl = stubFetch(jsonResponse({ iata: 'JFK', icao: 'KJFK' }));
  const provider = new AeroDataBoxProvider({ apiKey: 'RKEY', fetchImpl });
  await provider.search('airports', { code: 'KJFK' });
  assert.match(fetchImpl.calls[0].url, /\/airports\/icao\/KJFK$/);

  assert.deepEqual(await provider.search('airports', { code: '!!' }), []);
  assert.equal(new AeroDataBoxProvider({}).ready, false);
});

// ---- Travelpayouts ---------------------------------------------------------

test('TravelpayoutsProvider maps cached prices and builds deep links', async () => {
  const fetchImpl = stubFetch(jsonResponse({
    success: true,
    data: [{ origin: 'LAX', destination: 'JFK', price: 199, airline: 'B6', flight_number: 100, departure_at: '2026-07-01T08:00:00Z', transfers: 0, link: '/search/LAX0107JFK1' }]
  }));
  const provider = new TravelpayoutsProvider({ token: 'TP', fetchImpl });

  const offers = await provider.search('flights', { from: 'lax', to: 'jfk', date: '2026-07-01' });

  assert.equal(offers.length, 1);
  assert.equal(offers[0].price.amount, 199);
  assert.equal(offers[0].deepLink, 'https://www.aviasales.com/search/LAX0107JFK1');
  assert.equal(offers[0].details.airline, 'B6');
  assert.equal(fetchImpl.calls[0].options.headers['X-Access-Token'], 'TP');
});

test('TravelpayoutsProvider appends the marker to the aviasales deep link when configured', async () => {
  const fetchImpl = stubFetch(jsonResponse({
    success: true,
    data: [{ origin: 'LAX', destination: 'JFK', price: 199, link: '/search/LAX0107JFK1' }]
  }));
  const provider = new TravelpayoutsProvider({ token: 'TP', marker: '12345', fetchImpl });
  const offers = await provider.search('flights', { from: 'LAX', to: 'JFK' });
  assert.equal(offers[0].deepLink, 'https://www.aviasales.com/search/LAX0107JFK1?marker=12345');
});

test('HotelbedsProvider tolerates a sparse hotel record', async () => {
  const fetchImpl = stubFetch(jsonResponse({ hotels: { hotels: [{ code: 7 }] } }));
  const provider = new HotelbedsProvider({ apiKey: 'K', secret: 'S', fetchImpl, now: () => 0 });
  const offers = await provider.search('hotels', { cityCode: 'PMI', checkin: '2026-07-01', checkout: '2026-07-05' });
  assert.equal(offers[0].title, 'Hotel 7');
  assert.equal(offers[0].score, null); // no category -> no score
  assert.equal(offers[0].details.rooms, null);
});

test('HotelbedsProvider clamps out-of-range occupancy values', async () => {
  const fetchImpl = stubFetch(jsonResponse({ hotels: { hotels: [] } }));
  const provider = new HotelbedsProvider({ apiKey: 'K', secret: 'S', fetchImpl, now: () => 0 });
  await provider.search('hotels', { cityCode: 'PMI', checkin: '2026-07-01', checkout: '2026-07-05', rooms: '99', adults: '0', children: 'x' });
  const body = JSON.parse(fetchImpl.calls[0].options.body);
  assert.equal(body.occupancies[0].rooms, 8); // clamped to max
  assert.equal(body.occupancies[0].adults, 1); // clamped to min
  assert.equal(body.occupancies[0].children, 0); // invalid -> fallback
});

test('AeroDataBoxProvider returns [] when the airport payload is empty', async () => {
  const provider = new AeroDataBoxProvider({ apiKey: 'R', fetchImpl: stubFetch(jsonResponse({})) });
  assert.deepEqual(await provider.search('airports', { code: 'XYZ' }), []);
});

test('AeroDataBoxProvider tolerates a record missing location/country', async () => {
  const provider = new AeroDataBoxProvider({ apiKey: 'R', fetchImpl: stubFetch(jsonResponse({ icao: 'KXYZ', name: 'Tiny Field' })) });
  const offers = await provider.search('airports', { code: 'KXYZ' });
  assert.equal(offers[0].details.location, null);
  assert.equal(offers[0].details.country, null);
  assert.equal(offers[0].details.iata, null);
});

test('TravelpayoutsProvider tolerates sparse entries and missing transfers', async () => {
  const fetchImpl = stubFetch(jsonResponse({ data: [{ origin: 'LAX', destination: 'JFK', price: 150 }] }));
  const provider = new TravelpayoutsProvider({ token: 'T', fetchImpl });
  const offers = await provider.search('flights', { from: 'LAX', to: 'JFK' });
  assert.equal(offers[0].deepLink, null);
  assert.equal(offers[0].score, null);
  assert.equal(offers[0].title, 'LAX → JFK');
});

test('TravelpayoutsProvider surfaces upstream success:false as an error', async () => {
  const fetchImpl = stubFetch(jsonResponse({ success: false, error: 'bad token' }));
  const provider = new TravelpayoutsProvider({ token: 'TP', fetchImpl });
  await assert.rejects(() => provider.search('flights', { from: 'LAX', to: 'JFK' }), /bad token/);
  assert.equal(new TravelpayoutsProvider({}).ready, false);
});

test('TravelpayoutsProvider requests a round trip and defaults missing from/to', async () => {
  const fetchImpl = stubFetch(jsonResponse({ success: true, data: [] }));
  const provider = new TravelpayoutsProvider({ token: 'TP', fetchImpl });
  const offers = await provider.search('flights', { returnDate: '2026-07-15' });
  assert.deepEqual(offers, []);
  const url = fetchImpl.calls[0].url;
  assert.match(url, /one_way=false/);
  assert.match(url, /return_at=2026-07-15/);
  // Missing from/to fall back to empty origin/destination params.
  assert.match(url, /origin=&/);
  assert.match(url, /destination=&/);
});

test('TravelpayoutsProvider treats a non-array data payload as empty', async () => {
  const fetchImpl = stubFetch(jsonResponse({ success: true }));
  const provider = new TravelpayoutsProvider({ token: 'TP', fetchImpl });
  assert.deepEqual(await provider.search('flights', { from: 'LAX', to: 'JFK' }), []);
});

test('TravelpayoutsProvider defaults currency and nulls missing origin/destination', async () => {
  const fetchImpl = stubFetch(jsonResponse({ success: true, data: [{ price: 120 }] }));
  const provider = new TravelpayoutsProvider({ token: 'TP', currency: 'eur', fetchImpl });
  const offers = await provider.search('flights', { from: 'LAX', to: 'JFK' });
  assert.equal(offers[0].details.origin, null);
  assert.equal(offers[0].details.destination, null);
  assert.equal(offers[0].price.currency, 'EUR');
});

test('TravelpayoutsProvider prefers a per-entry currency when present', async () => {
  const fetchImpl = stubFetch(jsonResponse({ success: true, data: [{ origin: 'LAX', destination: 'JFK', price: 88, currency: 'gbp' }] }));
  const provider = new TravelpayoutsProvider({ token: 'TP', fetchImpl });
  const offers = await provider.search('flights', { from: 'LAX', to: 'JFK' });
  assert.equal(offers[0].price.currency, 'GBP');
});

test('TravelpayoutsProvider falls back to USD when neither entry nor provider currency is set', async () => {
  const fetchImpl = stubFetch(jsonResponse({ success: true, data: [{ origin: 'LAX', destination: 'JFK', price: 42 }] }));
  const provider = new TravelpayoutsProvider({ token: 'TP', fetchImpl });
  provider.currency = ''; // force the final `|| 'USD'` fallback for an entry lacking a currency
  const offers = await provider.search('flights', { from: 'LAX', to: 'JFK' });
  assert.equal(offers[0].price.currency, 'USD');
});

test('AeroDataBoxProvider returns [] when no code is supplied', async () => {
  const fetchImpl = stubFetch(jsonResponse({}));
  const provider = new AeroDataBoxProvider({ apiKey: 'R', fetchImpl });
  assert.deepEqual(await provider.search('airports', {}), []);
  assert.equal(fetchImpl.calls.length, 0);
});

test('AeroDataBoxProvider falls back for missing icao and location coordinates', async () => {
  const fetchImpl = stubFetch(jsonResponse({ iata: 'XYZ', name: 'Tiny Field', location: {} }));
  const provider = new AeroDataBoxProvider({ apiKey: 'R', fetchImpl });
  const offers = await provider.search('airports', { code: 'XYZ' });
  assert.equal(offers[0].details.icao, null);
  assert.equal(offers[0].title, 'Tiny Field (XYZ/?)');
  assert.deepEqual(offers[0].details.location, { lat: null, lon: null });
});

test('HotelbedsProvider is unconfigured when the secret is missing', () => {
  const provider = new HotelbedsProvider({ apiKey: 'k' });
  assert.equal(provider.ready, false);
  assert.equal(provider.status().configured, false);
});

test('HotelbedsProvider treats a missing hotels array as empty', async () => {
  const fetchImpl = stubFetch(jsonResponse({}));
  const provider = new HotelbedsProvider({ apiKey: 'K', secret: 'S', fetchImpl, now: () => 0 });
  assert.deepEqual(await provider.search('hotels', { cityCode: 'PMI', checkin: '2027-01-01', checkout: '2027-01-05' }), []);
});

test('HotelbedsProvider nulls a missing hotel code and uses the default clock', async () => {
  const fetchImpl = stubFetch(jsonResponse({ hotels: { hotels: [{ minRate: '99' }] } }));
  const provider = new HotelbedsProvider({ apiKey: 'K', secret: 'S', fetchImpl });
  const offers = await provider.search('hotels', { cityCode: 'PMI', checkin: '2027-01-01', checkout: '2027-01-05' });
  assert.equal(offers[0].details.code, null);
  // The default now() (Date.now) produced a 64-char SHA256 signature.
  assert.match(fetchImpl.calls[0].options.headers['X-Signature'], /^[0-9a-f]{64}$/);
});
