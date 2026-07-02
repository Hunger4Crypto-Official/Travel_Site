// Contract tests: run each provider's mapper against a recorded, real-shaped API
// response (test/fixtures/*) and assert the normalized output honors the
// comparison contract — a comparable `total`, correct `estimated`/`freshness`,
// and currency. This is the offline proof that mappings match documented shapes;
// `npm run smoke:live` proves them against the live APIs once keys + egress exist.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HotelbedsProvider } from '../src/providers/hotelbedsProvider.js';
import { TravelpayoutsProvider } from '../src/providers/travelpayoutsProvider.js';
import { OpenSkyProvider } from '../src/providers/openSkyProvider.js';
import { AdsbProvider } from '../src/providers/adsbProvider.js';
import { AeroDataBoxProvider } from '../src/providers/aeroDataBoxProvider.js';
import { jsonResponse, stubFetch } from './helpers/fakeFetch.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

test('contract: Hotelbeds fixture maps to an estimated net rate', async () => {
  const [offer] = await new HotelbedsProvider({ apiKey: 'k', secret: 's', fetchImpl: stubFetch(jsonResponse(fixture('hotelbeds.json'))), now: () => 0 })
    .search('hotels', { cityCode: 'PMI', checkin: '2026-07-01', checkout: '2026-07-05' });

  assert.equal(offer.price.total, 150);
  assert.equal(offer.price.currency, 'EUR');
  assert.equal(offer.price.estimated, true); // net "from" rate, not a final total
});

test('contract: Travelpayouts fixture maps to a cached, estimated fare', async () => {
  const [offer] = await new TravelpayoutsProvider({ token: 't', fetchImpl: stubFetch(jsonResponse(fixture('travelpayouts.json'))) })
    .search('flights', { from: 'LAX', to: 'JFK' });

  assert.equal(offer.price.total, 199);
  assert.equal(offer.price.estimated, true);
  assert.equal(offer.freshness, 'cached');
  assert.equal(offer.deepLink, 'https://www.aviasales.com/search/LAX0107JFK1');
});

test('contract: OpenSky + ADS-B fixtures map to zero-price tracking offers', async () => {
  const [sky] = await new OpenSkyProvider({ fetchImpl: stubFetch(jsonResponse(fixture('opensky.json'))) })
    .search('tracking', { icao24: '4b1814' });
  assert.equal(sky.details.callsign, 'SWR123');
  assert.equal(sky.price.total, 0);

  const [adsb] = await new AdsbProvider({ baseUrl: 'https://x', fetchImpl: stubFetch(jsonResponse(fixture('adsb.json'))) })
    .search('tracking', { icao24: '4b1814' });
  assert.equal(adsb.details.registration, 'HB-JCA');
  assert.equal(adsb.details.baroAltitudeFt, 38000);
});

test('contract: AeroDataBox fixture maps to enriched airport detail', async () => {
  const [offer] = await new AeroDataBoxProvider({ apiKey: 'r', fetchImpl: stubFetch(jsonResponse(fixture('aerodatabox.json'))) })
    .search('airports', { code: 'LAX' });
  assert.equal(offer.details.iata, 'LAX');
  assert.equal(offer.details.country, 'US');
  assert.equal(offer.details.elevationFt, 125);
});
