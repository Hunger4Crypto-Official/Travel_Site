import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AmadeusProvider } from '../src/providers/amadeusProvider.js';
import { HotelbedsProvider } from '../src/providers/hotelbedsProvider.js';
import { AeroDataBoxProvider } from '../src/providers/aeroDataBoxProvider.js';
import { TravelpayoutsProvider } from '../src/providers/travelpayoutsProvider.js';
import { jsonResponse, stubFetch } from './helpers/fakeFetch.js';

// ---- Amadeus ---------------------------------------------------------------

const amadeusFlightOffer = {
  id: '1',
  price: { grandTotal: '312.40', currency: 'USD' },
  numberOfBookableSeats: 4,
  itineraries: [{
    segments: [
      { departure: { iataCode: 'LAX', at: '2026-07-01T08:00:00' }, arrival: { iataCode: 'ORD' }, carrierCode: 'AA', number: '100' },
      { departure: { iataCode: 'ORD' }, arrival: { iataCode: 'JFK', at: '2026-07-01T16:00:00' }, carrierCode: 'AA', number: '200' }
    ]
  }]
};

function amadeusFetch() {
  return stubFetch((url) => {
    if (url.includes('/oauth2/token')) return jsonResponse({ access_token: 'tok-123', expires_in: 1799 });
    return jsonResponse({ data: [amadeusFlightOffer] });
  });
}

test('AmadeusProvider is not ready without credentials', () => {
  const provider = new AmadeusProvider({});
  assert.equal(provider.ready, false);
  assert.equal(provider.status().configured, false);
});

test('AmadeusProvider authenticates then maps flight offers', async () => {
  const fetchImpl = amadeusFetch();
  const provider = new AmadeusProvider({ clientId: 'id', clientSecret: 'secret', fetchImpl, now: () => 1000 });

  const offers = await provider.search('flights', { from: 'lax', to: 'jfk', date: '2026-07-01', adults: '2' });

  assert.equal(offers.length, 1);
  assert.equal(offers[0].price.amount, 312.4);
  assert.equal(offers[0].details.carriers[0], 'AA');
  assert.equal(offers[0].details.stops, 1);
  assert.equal(offers[0].title, 'LAX → JFK (AA)');

  // Token endpoint hit first with form-encoded credentials, then the search with Bearer auth.
  assert.match(fetchImpl.calls[0].url, /oauth2\/token/);
  assert.match(fetchImpl.calls[0].options.body, /grant_type=client_credentials/);
  assert.equal(fetchImpl.calls[1].options.headers.authorization, 'Bearer tok-123');
  assert.match(fetchImpl.calls[1].url, /originLocationCode=LAX&destinationLocationCode=JFK/);
});

test('AmadeusProvider caches the OAuth token until it nears expiry', async () => {
  const fetchImpl = amadeusFetch();
  let clock = 1000;
  const provider = new AmadeusProvider({ clientId: 'id', clientSecret: 'secret', fetchImpl, now: () => clock });

  await provider.search('flights', { from: 'LAX', to: 'JFK', date: '2026-07-01' });
  clock += 1000; // still well within the token lifetime
  await provider.search('flights', { from: 'LAX', to: 'JFK', date: '2026-07-01' });

  const tokenCalls = fetchImpl.calls.filter((c) => c.url.includes('/oauth2/token'));
  assert.equal(tokenCalls.length, 1);
});

test('AmadeusProvider throws when no access token is returned', async () => {
  const fetchImpl = stubFetch(jsonResponse({}));
  const provider = new AmadeusProvider({ clientId: 'id', clientSecret: 'secret', fetchImpl });
  await assert.rejects(() => provider.search('flights', { from: 'LAX', to: 'JFK', date: '2026-07-01' }), /access token/);
});

test('AmadeusProvider maps a sparse direct offer (no segments, fractional price)', async () => {
  const fetchImpl = stubFetch((url) => {
    if (url.includes('/oauth2/token')) return jsonResponse({ access_token: 't', expires_in: 1799 });
    return jsonResponse({ data: [{ id: '9', price: { total: '88.50' }, itineraries: [] }] });
  });
  const provider = new AmadeusProvider({ clientId: 'id', clientSecret: 'secret', fetchImpl });
  const offers = await provider.search('flights', { from: 'LAX', to: 'JFK', date: '2026-07-01' });
  assert.equal(offers[0].price.amount, 88.5);
  assert.equal(offers[0].title, 'Flight offer');
  assert.equal(offers[0].details.stops, 0);
  assert.equal(offers[0].details.departure, null);
});

test('AmadeusProvider passes optional return/children/cabin filters through', async () => {
  const fetchImpl = stubFetch((url) => url.includes('/oauth2/token')
    ? jsonResponse({ access_token: 't', expires_in: 1799 })
    : jsonResponse({ data: [] }));
  const provider = new AmadeusProvider({ clientId: 'id', clientSecret: 'secret', fetchImpl });
  await provider.search('flights', { from: 'LAX', to: 'JFK', date: '2026-07-01', returnDate: '2026-07-08', children: '1', cabin: 'business' });
  const searchUrl = fetchImpl.calls[1].url;
  assert.match(searchUrl, /returnDate=2026-07-08/);
  assert.match(searchUrl, /children=1/);
  assert.match(searchUrl, /travelClass=BUSINESS/);
});

test('AmadeusProvider only supports flights', async () => {
  const provider = new AmadeusProvider({ clientId: 'id', clientSecret: 'secret', fetchImpl: amadeusFetch() });
  assert.equal(provider.supports('hotels'), false);
  assert.deepEqual(await provider.search('hotels', {}), []);
});

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

// ---- AeroDataBox -----------------------------------------------------------

test('AeroDataBoxProvider looks up airports and sends RapidAPI headers', async () => {
  const fetchImpl = stubFetch(jsonResponse({
    iata: 'LAX', icao: 'KLAX', fullName: 'Los Angeles Intl', municipalityName: 'Los Angeles',
    country: { code: 'US' }, location: { lat: 33.9, lon: -118.4 }, timeZone: 'America/Los_Angeles', elevation: { feet: 125 }
  }));
  const provider = new AeroDataBoxProvider({ apiKey: 'RKEY', fetchImpl });

  const offers = await provider.search('airports', { code: 'lax' });

  assert.equal(offers.length, 1);
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
