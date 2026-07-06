// Contract tests: run each provider's mapper against a recorded, real-shaped API
// response (test/fixtures/*) and assert the normalized output honors the
// comparison contract: a comparable `total`, correct `estimated`/`freshness`,
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
import { SkyScrapperProvider } from '../src/providers/skyScrapperProvider.js';
import { BookingComProvider } from '../src/providers/bookingComProvider.js';
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

test('contract: Sky-Scrapper fixtures map to live all-in flight totals with segments', async () => {
  const fetchImpl = stubFetch((url) => url.includes('/searchAirport')
    ? jsonResponse(fixture('skyscrapper.searchAirport.json'))
    : jsonResponse(fixture('skyscrapper.searchFlights.json')));
  const offers = await new SkyScrapperProvider({ apiKey: 'r', fetchImpl })
    .search('flights', { from: 'LAX', to: 'JFK', date: '2026-07-01' });

  assert.equal(offers.length, 2);
  const [oneStop, nonStop] = offers;

  assert.equal(oneStop.price.total, 289.98);
  assert.equal(oneStop.price.currency, 'USD');
  assert.equal(oneStop.price.estimated, false); // Skyscanner displays all-in totals
  assert.equal(oneStop.freshness, 'live');
  assert.equal(oneStop.details.stops, 1);
  assert.equal(oneStop.details.segments.length, 2);
  assert.deepEqual(oneStop.details.segments[0], {
    carrier: 'B6', number: '424', at: '2026-07-01T08:00:00', from: 'LAX', to: 'SLC'
  });

  assert.equal(nonStop.price.total, 412.4);
  assert.equal(nonStop.details.stops, 0);
  assert.equal(nonStop.score, 94); // itinerary score 0.94 scaled
  assert.match(nonStop.title, /LAX → JFK \(American Airlines\)/);

  // Every priced offer carries an actionable Skyscanner deep link.
  assert.equal(oneStop.deepLink, 'https://www.skyscanner.net/transport/flights/lax/jfk/260701/');
  assert.equal(nonStop.deepLink, 'https://www.skyscanner.net/transport/flights/lax/jfk/260701/');
});

test('contract: Booking.com fixtures map gross + excluded charges to an all-in total', async () => {
  const fetchImpl = stubFetch((url) => url.includes('/searchDestination')
    ? jsonResponse(fixture('bookingcom.searchDestination.json'))
    : jsonResponse(fixture('bookingcom.searchHotels.json')));
  const offers = await new BookingComProvider({ apiKey: 'r', fetchImpl })
    .search('hotels', { city: 'Las Vegas', checkin: '2026-07-01', checkout: '2026-07-05' });

  assert.equal(offers.length, 2);
  const [bellagio, linq] = offers;

  assert.equal(bellagio.title, 'Bellagio');
  assert.equal(bellagio.price.base, 979.76);
  assert.equal(bellagio.price.fees, 132.4);            // Booking's excluded charges
  assert.equal(bellagio.price.total, 979.76 + 132.4);  // all-in for ranking
  assert.equal(bellagio.price.estimated, false);
  assert.equal(bellagio.freshness, 'live');
  assert.equal(bellagio.score, 87); // reviewScore 8.7 scaled
  assert.equal(bellagio.details.city, 'Las Vegas');
  assert.equal(bellagio.details.code, undefined); // internal ids stay out of dedupe keys

  assert.equal(linq.price.total, 412.05); // no excluded charges reported
  assert.equal(linq.price.fees, null);

  // Every priced offer carries an actionable Booking.com deep link.
  assert.equal(
    bellagio.deepLink,
    'https://www.booking.com/searchresults.html?ss=Bellagio&checkin=2026-07-01&checkout=2026-07-05'
  );
});

test('contract: AeroDataBox fixture maps to enriched airport detail', async () => {
  const [offer] = await new AeroDataBoxProvider({ apiKey: 'r', fetchImpl: stubFetch(jsonResponse(fixture('aerodatabox.json'))) })
    .search('airports', { code: 'LAX' });
  assert.equal(offer.details.iata, 'LAX');
  assert.equal(offer.details.country, 'US');
  assert.equal(offer.details.elevationFt, 125);
});
