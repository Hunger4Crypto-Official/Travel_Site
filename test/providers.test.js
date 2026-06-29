import test from 'node:test';
import assert from 'node:assert/strict';
import { AirportInfoProvider } from '../src/providers/airportInfoProvider.js';
import { OpenSkyProvider } from '../src/providers/openSkyProvider.js';
import { AdsbProvider } from '../src/providers/adsbProvider.js';
import { TravelEngine } from '../src/engine/travelEngine.js';
import { jsonResponse, errorResponse, stubFetch } from './helpers/fakeFetch.js';

// A single OpenSky state vector for ICAO24 4b1814, per the documented order.
const sampleState = [
  '4b1814', 'SWR123 ', 'Switzerland', 1700000000, 1700000005,
  8.5, 47.4, 10972.8, false, 250.3, 91.2, 0.0, null, 11000.0, '1000', false, 0
];

test('AirportInfoProvider only supports the airports vertical', () => {
  const provider = new AirportInfoProvider();
  assert.equal(provider.supports('airports'), true);
  assert.equal(provider.supports('flights'), false);
});

test('AirportInfoProvider returns real reference data by IATA code (case-insensitive)', async () => {
  const provider = new AirportInfoProvider();
  const offers = await provider.search('airports', { code: 'lax' });

  assert.equal(offers.length, 1);
  assert.equal(offers[0].details.iata, 'LAX');
  assert.equal(offers[0].details.icao, 'KLAX');
  assert.equal(offers[0].details.city, 'Los Angeles');
  assert.equal(typeof offers[0].details.location.lat, 'number');
});

test('AirportInfoProvider also resolves ICAO codes and reports unknown codes as no results', async () => {
  const provider = new AirportInfoProvider();
  const byIcao = await provider.search('airports', { code: 'KJFK' });
  const unknown = await provider.search('airports', { code: 'ZZZ' });

  assert.equal(byIcao[0].details.iata, 'JFK');
  assert.equal(unknown.length, 0);
});

test('AirportInfoProvider returns [] for non-airport verticals and reports dataset size', async () => {
  const provider = new AirportInfoProvider();
  assert.deepEqual(await provider.search('flights', { from: 'LAX', to: 'JFK' }), []);
  assert.ok(provider.status().airports > 0);
});

test('OpenSkyProvider maps a live state vector into a normalized offer', async () => {
  const fetchImpl = stubFetch((url) => {
    assert.match(url, /states\/all\?icao24=4b1814/);
    return jsonResponse({ time: 1700000010, states: [sampleState] });
  });
  const provider = new OpenSkyProvider({ fetchImpl, timeoutMs: 5000 });

  const offers = await provider.search('tracking', { icao24: '4B1814' });

  assert.equal(offers.length, 1);
  assert.equal(offers[0].provider, 'opensky-network');
  assert.equal(offers[0].details.icao24, '4b1814');
  assert.equal(offers[0].details.callsign, 'SWR123');
  assert.equal(offers[0].details.onGround, false);
  assert.equal(offers[0].details.latitude, 47.4);
  assert.equal(offers[0].details.lastContact, new Date(1700000005 * 1000).toISOString());
});

test('OpenSkyProvider returns no offers when no aircraft are broadcasting', async () => {
  const provider = new OpenSkyProvider({ fetchImpl: stubFetch(jsonResponse({ time: 1, states: null })) });
  assert.deepEqual(await provider.search('tracking', { icao24: '4b1814' }), []);
});

test('OpenSkyProvider returns [] for non-tracking verticals', async () => {
  const provider = new OpenSkyProvider({ fetchImpl: stubFetch(jsonResponse({})) });
  assert.deepEqual(await provider.search('flights', {}), []);
});

test('OpenSkyProvider throws on a non-OK upstream response', async () => {
  const provider = new OpenSkyProvider({ fetchImpl: stubFetch(errorResponse(429)) });
  await assert.rejects(() => provider.search('tracking', { icao24: '4b1814' }), /status 429/);
});

test('OpenSkyProvider sends basic auth when credentials are configured', async () => {
  const fetchImpl = stubFetch(jsonResponse({ time: 1, states: [] }));
  const provider = new OpenSkyProvider({ fetchImpl, username: 'user', password: 'pass' });
  await provider.search('tracking', { icao24: '4b1814' });

  assert.equal(
    fetchImpl.calls[0].options.headers.authorization,
    `Basic ${Buffer.from('user:pass').toString('base64')}`
  );
  assert.equal(provider.status().authenticated, true);
});

test('AdsbProvider requires a baseUrl', () => {
  assert.throws(() => new AdsbProvider({}), /requires a baseUrl/);
});

test('AdsbProvider maps a readsb aircraft record into a tracking offer', async () => {
  const fetchImpl = stubFetch((url) => {
    assert.match(url, /\/v2\/icao\/4b1814$/);
    return jsonResponse({ now: 1700000010000, ac: [{ hex: '4B1814', flight: 'SWR123 ', lat: 47.4, lon: 8.5, alt_baro: 38000, gs: 450, track: 90, baro_rate: 0, squawk: '1000', r: 'HB-JCA', t: 'A20N', seen: 2 }] });
  });
  const provider = new AdsbProvider({ name: 'adsb-lol', baseUrl: 'https://api.adsb.lol/', fetchImpl });

  const offers = await provider.search('tracking', { icao24: '4B1814' });

  assert.equal(offers.length, 1);
  assert.equal(offers[0].details.icao24, '4b1814');
  assert.equal(offers[0].details.callsign, 'SWR123');
  assert.equal(offers[0].details.registration, 'HB-JCA');
  assert.equal(offers[0].details.baroAltitudeFt, 38000);
  assert.equal(offers[0].details.observedAt, new Date(1700000010000 - 2000).toISOString());
});

test('AdsbProvider handles the on-ground altitude sentinel and empty results', async () => {
  const ground = new AdsbProvider({ baseUrl: 'https://x', fetchImpl: stubFetch(jsonResponse({ now: 1, ac: [{ hex: 'abc123', alt_baro: 'ground' }] })) });
  const groundOffers = await ground.search('tracking', { icao24: 'abc123' });
  assert.equal(groundOffers[0].details.baroAltitudeFt, 'ground');

  const empty = new AdsbProvider({ baseUrl: 'https://x', fetchImpl: stubFetch(jsonResponse({ now: 1, ac: null })) });
  assert.deepEqual(await empty.search('tracking', { icao24: 'abc123' }), []);
});

test('OpenSkyProvider tolerates sparse state vectors (all optional fields missing)', async () => {
  // Minimal state: only icao24 present, the rest undefined.
  const sparse = ['abc123'];
  const provider = new OpenSkyProvider({ fetchImpl: stubFetch(jsonResponse({ time: null, states: [sparse] })) });
  const offers = await provider.search('tracking', { icao24: 'abc123' });
  assert.equal(offers[0].details.callsign, null);
  assert.equal(offers[0].details.latitude, null);
  assert.equal(offers[0].details.lastContact, null);
  assert.equal(offers[0].details.snapshotTime, null);
  assert.equal(offers[0].title, 'Live position for abc123');
});

test('AdsbProvider tolerates a record with only a hex code', async () => {
  const provider = new AdsbProvider({ baseUrl: 'https://x', fetchImpl: stubFetch(jsonResponse({ ac: [{}] })) });
  const offers = await provider.search('tracking', { icao24: 'abc123' });
  assert.equal(offers[0].details.icao24, null);
  assert.equal(offers[0].details.latitude, null);
  assert.equal(offers[0].details.observedAt, null);
  assert.equal(offers[0].title, 'Live position for aircraft');
});

test('TravelEngine serves real live tracking through the OpenSky provider', async () => {
  const fetchImpl = stubFetch(jsonResponse({ time: 1700000010, states: [sampleState] }));
  const engine = new TravelEngine({ providers: [new OpenSkyProvider({ fetchImpl })] });

  const result = await engine.search('tracking', { icao24: '4b1814' });

  assert.equal(result.count, 1);
  assert.equal(result.offers[0].details.callsign, 'SWR123');
  assert.equal(result.providers[0].status, 'success');
});

test('TravelEngine serves real airport info through the airport provider', async () => {
  const engine = new TravelEngine({ providers: [new AirportInfoProvider()] });

  const result = await engine.search('airports', { code: 'SFO' });

  assert.equal(result.count, 1);
  assert.equal(result.offers[0].details.name, 'San Francisco International');
});
