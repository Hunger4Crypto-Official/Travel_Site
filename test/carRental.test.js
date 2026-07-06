import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CarRentalProvider } from '../src/providers/carRentalProvider.js';
import { jsonResponse, stubFetch } from './helpers/fakeFetch.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

// A pickup city that resolves to coordinates (Booking's car searchDestination
// returns a `coordinates` object per entry).
const vegasCoord = {
  dest_id: '20079110',
  name: 'Las Vegas',
  city: 'Las Vegas',
  type: 'city',
  coordinates: { latitude: 36.1146, longitude: -115.1728 }
};

const corolla = {
  vehicle_id: '705328917',
  deeplink: 'https://cars.booking.com/x',
  vehicle_info: { v_name: 'Toyota Corolla', group: 'Compact', transmission: 'Automatic', seats: '5' },
  supplier_info: { name: 'Hertz' },
  pricing_info: { price: 154.32, currency: 'USD' },
  route_info: { pickup: { name: 'Harry Reid International Airport' } }
};

function carFetch(overrides = {}) {
  return stubFetch((url) => {
    if (url.includes('/searchDestination')) {
      return jsonResponse(overrides.destinations ?? { status: true, data: [vegasCoord] });
    }
    return jsonResponse(overrides.cars ?? { status: true, data: { search_results: [corolla] } });
  });
}

test('CarRentalProvider is not ready without an API key and only supports cars', () => {
  const provider = new CarRentalProvider({});
  assert.equal(provider.ready, false);
  assert.equal(provider.supports('cars'), true);
  assert.equal(provider.supports('hotels'), false);
  assert.deepEqual(provider.status().supports, ['cars']);

  const configured = new CarRentalProvider({ apiKey: 'k' });
  assert.equal(configured.ready, true);
  assert.equal(configured.status().configured, true);
  assert.equal(new CarRentalProvider({ apiKey: 'k', enabled: false }).ready, false);
});

test('CarRentalProvider returns [] for non-car verticals without calling out', async () => {
  const fetchImpl = carFetch();
  const provider = new CarRentalProvider({ apiKey: 'k', fetchImpl });
  assert.deepEqual(await provider.search('hotels', { city: 'Las Vegas' }), []);
  assert.equal(fetchImpl.calls.length, 0);
});

test('CarRentalProvider resolves the city to coordinates, maps offers, and sends RapidAPI headers', async () => {
  const fetchImpl = carFetch();
  const provider = new CarRentalProvider({ apiKey: 'k', fetchImpl });
  const offers = await provider.search('cars', { city: 'Las Vegas', date: '2026-07-01', dropoff: '2026-07-06' });

  assert.equal(offers.length, 1);
  const [offer] = offers;
  assert.equal(offer.price.amount, 154.32);
  assert.equal(offer.price.total, 154.32);
  assert.equal(offer.price.currency, 'USD');
  assert.equal(offer.price.estimated, true); // "from" rate, not an all-in total
  assert.equal(offer.freshness, 'live');
  assert.equal(offer.id, 'car-rental-705328917');
  assert.equal(offer.title, 'Toyota Corolla (Hertz)');
  assert.equal(offer.deepLink, 'https://cars.booking.com/x');
  assert.equal(offer.details.supplier, 'Hertz');
  assert.equal(offer.details.vehicleClass, 'Compact');
  assert.equal(offer.details.seats, 5);
  assert.equal(offer.details.transmission, 'Automatic');
  assert.equal(offer.details.pickupLocation, 'Harry Reid International Airport');

  const destCall = fetchImpl.calls.find((c) => c.url.includes('/searchDestination'));
  assert.ok(destCall, 'destination is resolved before searching');

  const carCall = fetchImpl.calls.find((c) => c.url.includes('/searchCarRentals'));
  const params = new URL(carCall.url).searchParams;
  assert.equal(params.get('pick_up_latitude'), '36.1146');
  assert.equal(params.get('pick_up_longitude'), '-115.1728');
  assert.equal(params.get('drop_off_latitude'), '36.1146');
  assert.equal(params.get('drop_off_longitude'), '-115.1728');
  assert.equal(params.get('pick_up_date'), '2026-07-01');
  assert.equal(params.get('drop_off_date'), '2026-07-06');
  assert.equal(params.get('pick_up_time'), '10:00');
  assert.equal(params.get('drop_off_time'), '10:00');
  assert.equal(params.get('currency_code'), 'USD');
  assert.equal(carCall.options.headers['X-RapidAPI-Key'], 'k');
  assert.equal(carCall.options.headers['X-RapidAPI-Host'], 'booking-com15.p.rapidapi.com');
  assert.equal(carCall.options.headers.accept, 'application/json');
});

test('CarRentalProvider caches destination resolution across searches', async () => {
  const fetchImpl = carFetch();
  const provider = new CarRentalProvider({ apiKey: 'k', fetchImpl });
  await provider.search('cars', { city: 'Las Vegas' });
  await provider.search('cars', { city: 'las vegas' }); // case-insensitive cache key

  const destCalls = fetchImpl.calls.filter((c) => c.url.includes('/searchDestination'));
  assert.equal(destCalls.length, 1);
});

test('CarRentalProvider returns [] when the city cannot be resolved, has no data, or is missing', async () => {
  const noCoords = carFetch({ destinations: { status: true, data: [{ name: 'x' }] } });
  assert.deepEqual(await new CarRentalProvider({ apiKey: 'k', fetchImpl: noCoords }).search('cars', { city: 'Nowhere' }), []);

  const noData = carFetch({ destinations: { status: true } }); // no data array
  assert.deepEqual(await new CarRentalProvider({ apiKey: 'k', fetchImpl: noData }).search('cars', { city: 'X' }), []);

  const missing = carFetch();
  assert.deepEqual(await new CarRentalProvider({ apiKey: 'k', fetchImpl: missing }).search('cars', {}), []);
  assert.equal(missing.calls.length, 0); // no city -> no calls at all
});

test('CarRentalProvider tolerates varied destination coordinate shapes and skips coordinateless entries', async () => {
  const fetchImpl = stubFetch((url) => {
    if (url.includes('/searchDestination')) {
      const q = new URL(url).searchParams.get('query');
      // First entry null, second lacks coordinates, third has a lat but no lon
      // (finite lat / non-finite lon), fourth uses flat lat/lon.
      if (q === 'flatlon') return jsonResponse({ status: true, data: [null, { name: 'z' }, { lat: 12.3 }, { lat: 40.7, lon: -74.0 }] });
      // Nested coordinates using the `lng` longitude alias, name from city.
      return jsonResponse({ status: true, data: [{ coordinates: { latitude: 51.5, lng: -0.12 }, city: 'London' }] });
    }
    return jsonResponse({ status: true, data: { search_results: [] } });
  });
  const provider = new CarRentalProvider({ apiKey: 'k', fetchImpl });
  await provider.search('cars', { city: 'flatlon' });
  await provider.search('cars', { city: 'lnglondon' });

  const carCalls = fetchImpl.calls.filter((c) => c.url.includes('/searchCarRentals'));
  const flat = new URL(carCalls[0].url).searchParams;
  assert.equal(flat.get('pick_up_latitude'), '40.7');   // flat lat
  assert.equal(flat.get('pick_up_longitude'), '-74');   // flat lon
  const nested = new URL(carCalls[1].url).searchParams;
  assert.equal(nested.get('pick_up_latitude'), '51.5'); // coordinates.latitude
  assert.equal(nested.get('pick_up_longitude'), '-0.12'); // coordinates.lng alias
});

test('CarRentalProvider fills name/currency/supplier/link/pickup fallbacks', async () => {
  const records = [
    // url deeplink, vehicle.name fallback, no supplier, base_currency, category class,
    // non-numeric seats -> null, no route_info -> pickupLocation from destination name.
    { url: 'https://cars.example/a', vehicle_info: { name: 'Kia Rio', category: 'Economy', seats: 'n/a', transmission: 'Manual' }, pricing_info: { price: 99.5, base_currency: 'EUR' } },
    // pricing.deeplink, name that slugs to empty -> id 'car', empty supplier -> null,
    // no currency -> provider currency, pickup address fallback.
    { vehicle_info: { v_name: '!!!' }, supplier_info: {}, pricing_info: { price: 42, deeplink: 'https://cars.example/b' }, route_info: { pickup: { address: '123 Main St' } } },
    // no links -> deepLink null, group class, numeric seats, no transmission, provider currency.
    { vehicle_id: 'v3', vehicle_info: { v_name: 'Ford Focus', group: 'Compact', seats: '5' }, supplier_info: { name: 'Avis' }, pricing_info: { price: 120 } }
  ];
  const fetchImpl = carFetch({ cars: { status: true, data: { search_results: records } } });
  const offers = await new CarRentalProvider({ apiKey: 'k', currency: 'gbp', fetchImpl }).search('cars', { city: 'Las Vegas' });

  assert.equal(offers.length, 3);
  const [a, b, c] = offers;

  assert.equal(a.id, 'car-rental-kia-rio'); // slug from name + empty supplier
  assert.equal(a.title, 'Kia Rio');         // no supplier -> name only
  assert.equal(a.deepLink, 'https://cars.example/a');
  assert.equal(a.price.currency, 'EUR');    // base_currency fallback
  assert.equal(a.details.supplier, null);
  assert.equal(a.details.vehicleClass, 'Economy'); // category fallback
  assert.equal(a.details.seats, null);      // non-numeric seats
  assert.equal(a.details.pickupLocation, 'Las Vegas'); // destination name fallback

  assert.equal(b.id, 'car-rental-car');     // empty slug -> 'car'
  assert.equal(b.title, '!!!');
  assert.equal(b.deepLink, 'https://cars.example/b'); // pricing.deeplink fallback
  assert.equal(b.price.currency, 'GBP');    // provider currency fallback
  assert.equal(b.details.pickupLocation, '123 Main St'); // pickup address fallback

  assert.equal(c.id, 'car-rental-v3');
  assert.equal(c.title, 'Ford Focus (Avis)');
  assert.equal(c.deepLink, null);           // no link anywhere
  assert.equal(c.price.currency, 'GBP');
  assert.equal(c.details.vehicleClass, 'Compact');
  assert.equal(c.details.seats, 5);
  assert.equal(c.details.transmission, null);
});

test('CarRentalProvider skips records without a usable name or finite price', async () => {
  const nameless = { vehicle_id: 1, vehicle_info: {}, pricing_info: { price: 100 } };
  const priceless = { vehicle_id: 2, vehicle_info: { v_name: 'Ghost Car' }, pricing_info: { price: 'call us' } };
  const noVehicleInfo = { vehicle_id: 4, pricing_info: { price: 100 } };  // vehicle_info absent -> no name
  const noPricingInfo = { vehicle_id: 5, vehicle_info: { v_name: 'No Price Car' } }; // pricing_info absent -> no price
  const good = { vehicle_id: 3, vehicle_info: { v_name: 'Nissan Versa' }, supplier_info: { name: 'Sixt' }, pricing_info: { price: 77 } };
  const fetchImpl = carFetch({ cars: { status: true, data: { search_results: [nameless, priceless, noVehicleInfo, noPricingInfo, good] } } });
  const offers = await new CarRentalProvider({ apiKey: 'k', fetchImpl }).search('cars', { city: 'Las Vegas' });

  assert.equal(offers.length, 1);
  assert.equal(offers[0].title, 'Nissan Versa (Sixt)');
  assert.equal(offers[0].price.total, 77);
});

test('CarRentalProvider returns [] when the car payload has no results array', async () => {
  const fetchImpl = carFetch({ cars: { status: true, data: {} } });
  assert.deepEqual(await new CarRentalProvider({ apiKey: 'k', fetchImpl }).search('cars', { city: 'Las Vegas' }), []);
});

test('CarRentalProvider surfaces an API rejection (array, string, and empty messages)', async () => {
  const arr = carFetch({ cars: { status: false, message: ['pick_up_date is required', { field: 'x' }] } });
  await assert.rejects(
    new CarRentalProvider({ apiKey: 'k', fetchImpl: arr }).search('cars', { city: 'Las Vegas' }),
    /Car rental error: pick_up_date is required; .*"field"/
  );

  const str = carFetch({ cars: { status: false, message: 'quota exceeded' } });
  await assert.rejects(
    new CarRentalProvider({ apiKey: 'k', fetchImpl: str }).search('cars', { city: 'Las Vegas' }),
    /Car rental error: quota exceeded/
  );

  const none = carFetch({ cars: { status: false } });
  await assert.rejects(
    new CarRentalProvider({ apiKey: 'k', fetchImpl: none }).search('cars', { city: 'Las Vegas' }),
    /Car rental error: request rejected/
  );
});

test('CarRentalProvider defaults drop-off to pickup + 3 days, omits absent dates, and guards invalid dates', async () => {
  const fetchImpl = carFetch();
  const provider = new CarRentalProvider({ apiKey: 'k', fetchImpl });

  await provider.search('cars', { city: 'Las Vegas', date: '2026-07-01' });
  let params = new URL(fetchImpl.calls.at(-1).url).searchParams;
  assert.equal(params.get('pick_up_date'), '2026-07-01');
  assert.equal(params.get('drop_off_date'), '2026-07-04'); // pickup + 3 days

  await provider.search('cars', { city: 'Las Vegas' }); // no date at all
  params = new URL(fetchImpl.calls.at(-1).url).searchParams;
  assert.equal(params.get('pick_up_date'), null);
  assert.equal(params.get('drop_off_date'), null);

  await provider.search('cars', { city: 'Las Vegas', date: 'not-a-date' }); // invalid -> guarded, no date sent
  params = new URL(fetchImpl.calls.at(-1).url).searchParams;
  assert.equal(params.get('pick_up_date'), null);
});

test('contract: recorded car fixtures map to estimated from-price offers with one sparse skip', async () => {
  const fetchImpl = stubFetch((url) => (url.includes('/searchDestination')
    ? jsonResponse(fixture('carrental.searchDestination.json'))
    : jsonResponse(fixture('carrental.searchCarRentals.json'))));
  const offers = await new CarRentalProvider({ apiKey: 'r', fetchImpl })
    .search('cars', { city: 'Las Vegas', date: '2026-07-01' });

  assert.equal(offers.length, 1); // the second, name-less record is skipped
  const [car] = offers;
  assert.equal(car.title, 'Toyota Corolla (Hertz)');
  assert.equal(car.price.total, 154.32);
  assert.equal(car.price.currency, 'USD');
  assert.equal(car.price.estimated, true);
  assert.equal(car.freshness, 'live');
  assert.equal(car.details.supplier, 'Hertz');
  assert.equal(car.details.vehicleClass, 'Compact');
  assert.equal(car.details.seats, 5);
  assert.equal(car.details.transmission, 'Automatic');
  assert.equal(car.details.pickupLocation, 'Harry Reid International Airport');
  assert.equal(car.deepLink, 'https://cars.booking.com/search-results?vehicle_id=705328917');
});
