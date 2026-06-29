import test from 'node:test';
import assert from 'node:assert/strict';
import { AirportInfoProvider } from '../src/providers/airportInfoProvider.js';
import { OpenSkyProvider } from '../src/providers/openSkyProvider.js';
import { TravelEngine } from '../src/engine/travelEngine.js';

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

test('OpenSkyProvider maps a live state vector into a normalized offer', async () => {
  const fetchImpl = async (url) => {
    assert.match(url, /states\/all\?icao24=4b1814/);
    return { ok: true, async json() { return { time: 1700000010, states: [sampleState] }; } };
  };
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
  const fetchImpl = async () => ({ ok: true, async json() { return { time: 1, states: null }; } });
  const provider = new OpenSkyProvider({ fetchImpl });

  assert.deepEqual(await provider.search('tracking', { icao24: '4b1814' }), []);
});

test('OpenSkyProvider throws on a non-OK upstream response', async () => {
  const fetchImpl = async () => ({ ok: false, status: 429, async json() { return {}; } });
  const provider = new OpenSkyProvider({ fetchImpl });

  await assert.rejects(() => provider.search('tracking', { icao24: '4b1814' }), /status 429/);
});

test('OpenSkyProvider sends basic auth when credentials are configured', async () => {
  let seenAuth;
  const fetchImpl = async (_url, options) => {
    seenAuth = options.headers.authorization;
    return { ok: true, async json() { return { time: 1, states: [] }; } };
  };
  const provider = new OpenSkyProvider({ fetchImpl, username: 'user', password: 'pass' });
  await provider.search('tracking', { icao24: '4b1814' });

  assert.equal(seenAuth, `Basic ${Buffer.from('user:pass').toString('base64')}`);
});

test('TravelEngine serves real live tracking through the OpenSky provider', async () => {
  const fetchImpl = async () => ({ ok: true, async json() { return { time: 1700000010, states: [sampleState] }; } });
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
