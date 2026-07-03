import test from 'node:test';
import assert from 'node:assert/strict';
import { SkyScrapperProvider } from '../src/providers/skyScrapperProvider.js';
import { BookingComProvider } from '../src/providers/bookingComProvider.js';
import { jsonResponse, stubFetch } from './helpers/fakeFetch.js';

// ---- Sky-Scrapper -----------------------------------------------------------

const laxPlace = {
  skyId: 'LAX',
  entityId: '27544850',
  navigation: { relevantFlightParams: { skyId: 'LAX', entityId: '27544850', flightPlaceType: 'AIRPORT' } }
};
const jfkPlace = {
  skyId: 'JFK',
  entityId: '27537542',
  navigation: { relevantFlightParams: { skyId: 'JFK', entityId: '27537542', flightPlaceType: 'AIRPORT' } }
};
const itinerary = {
  id: 'itin-1',
  price: { raw: 199.5, formatted: '$200' },
  legs: [{
    origin: { displayCode: 'LAX' },
    destination: { displayCode: 'JFK' },
    durationInMinutes: 320,
    stopCount: 0,
    departure: '2026-07-01T09:15:00',
    arrival: '2026-07-01T17:35:00',
    carriers: { marketing: [{ alternateId: 'AA', name: 'American Airlines' }] },
    segments: [{
      origin: { displayCode: 'LAX' },
      destination: { displayCode: 'JFK' },
      departure: '2026-07-01T09:15:00',
      flightNumber: '100',
      marketingCarrier: { alternateId: 'AA', name: 'American Airlines' }
    }]
  }],
  score: 0.9
};

function skyFetch(overrides = {}) {
  return stubFetch((url) => {
    if (url.includes('/searchAirport')) {
      const query = new URL(url).searchParams.get('query');
      return jsonResponse({ status: true, data: query === 'JFK' ? [jfkPlace] : [laxPlace] });
    }
    return jsonResponse(overrides.flights ?? { status: true, data: { itineraries: [itinerary] } });
  });
}

test('SkyScrapperProvider is not ready without an API key and only supports flights', () => {
  const provider = new SkyScrapperProvider({});
  assert.equal(provider.ready, false);
  assert.equal(provider.supports('flights'), true);
  assert.equal(provider.supports('hotels'), false);
  assert.deepEqual(provider.status().supports, ['flights']);

  const configured = new SkyScrapperProvider({ apiKey: 'k' });
  assert.equal(configured.ready, true);
  assert.equal(configured.status().configured, true);
});

test('SkyScrapperProvider returns [] for non-flight verticals without calling out', async () => {
  const fetchImpl = skyFetch();
  const provider = new SkyScrapperProvider({ apiKey: 'k', fetchImpl });
  assert.deepEqual(await provider.search('hotels', { city: 'X' }), []);
  assert.equal(fetchImpl.calls.length, 0);
});

test('SkyScrapperProvider resolves both endpoints, maps offers, and sends RapidAPI headers', async () => {
  const fetchImpl = skyFetch();
  const provider = new SkyScrapperProvider({ apiKey: 'k', fetchImpl });
  const offers = await provider.search('flights', { from: 'LAX', to: 'JFK', date: '2026-07-01', adults: '2' });

  assert.equal(offers.length, 1);
  assert.equal(offers[0].price.total, 199.5);
  assert.equal(offers[0].price.estimated, false);
  assert.equal(offers[0].details.segments[0].carrier, 'AA');
  assert.equal(offers[0].score, 90);

  const flightCall = fetchImpl.calls.find((c) => c.url.includes('/searchFlights'));
  const params = new URL(flightCall.url).searchParams;
  assert.equal(params.get('originSkyId'), 'LAX');
  assert.equal(params.get('destinationEntityId'), '27537542');
  assert.equal(params.get('adults'), '2');
  assert.equal(params.get('date'), '2026-07-01');
  assert.equal(flightCall.options.headers['X-RapidAPI-Key'], 'k');
  assert.equal(flightCall.options.headers['X-RapidAPI-Host'], 'sky-scrapper.p.rapidapi.com');
});

test('SkyScrapperProvider caches place resolution across searches', async () => {
  const fetchImpl = skyFetch();
  const provider = new SkyScrapperProvider({ apiKey: 'k', fetchImpl });
  await provider.search('flights', { from: 'LAX', to: 'JFK' });
  await provider.search('flights', { from: 'LAX', to: 'JFK' });

  const airportCalls = fetchImpl.calls.filter((c) => c.url.includes('/searchAirport'));
  assert.equal(airportCalls.length, 2); // once per endpoint, not per search
});

test('SkyScrapperProvider returns [] when a place cannot be resolved', async () => {
  const fetchImpl = stubFetch(jsonResponse({ status: true, data: [] }));
  const provider = new SkyScrapperProvider({ apiKey: 'k', fetchImpl });
  assert.deepEqual(await provider.search('flights', { from: 'NOWHERE', to: 'JFK' }), []);
  assert.deepEqual(await provider.search('flights', { from: '', to: '' }), []);
});

test('SkyScrapperProvider surfaces an API rejection as an error (array message: strings + objects)', async () => {
  const fetchImpl = skyFetch({ flights: { status: false, message: ['bad date', { date: 'invalid' }] } });
  const provider = new SkyScrapperProvider({ apiKey: 'k', fetchImpl });
  await assert.rejects(
    provider.search('flights', { from: 'LAX', to: 'JFK' }),
    /Sky-Scrapper error: bad date; .*invalid/
  );
});

test('SkyScrapperProvider surfaces a plain-string API error message', async () => {
  const fetchImpl = skyFetch({ flights: { status: false, message: 'quota exceeded' } });
  await assert.rejects(
    new SkyScrapperProvider({ apiKey: 'k', fetchImpl }).search('flights', { from: 'LAX', to: 'JFK' }),
    /Sky-Scrapper error: quota exceeded/
  );
});

test('SkyScrapperProvider fills segment/route fallbacks and forwards cabin + returnDate', async () => {
  const edgeItinerary = {
    // no id -> id derived from segment carrier+number; no carriers block -> no carrier name
    price: { raw: 250 },
    legs: [{
      origin: { flightPlaceId: 'LAX' },   // no displayCode -> route shows '?'
      destination: {},                     // nothing -> route shows '?'
      stopCount: 2,
      segments: [{
        marketingCarrier: { name: 'JetBlue' }, // no alternateId -> falls back to name
        origin: { flightPlaceId: 'LAX' },      // no displayCode -> falls back to flightPlaceId
        destination: {},                        // neither -> null
        departure: '2026-07-01T08:00:00',
        flightNumber: '9'
      }]
    }],
    score: 0.5
  };
  const fetchImpl = skyFetch({ flights: { status: true, data: { itineraries: [edgeItinerary] } } });
  const offers = await new SkyScrapperProvider({ apiKey: 'k', fetchImpl })
    .search('flights', { from: 'LAX', to: 'JFK', cabin: 'business', returnDate: '2026-07-10' });

  assert.equal(offers.length, 1);
  const [offer] = offers;
  assert.equal(offer.details.segments[0].carrier, 'JetBlue'); // name fallback
  assert.equal(offer.details.segments[0].from, 'LAX');        // flightPlaceId fallback
  assert.equal(offer.details.segments[0].to, null);           // both missing
  assert.equal(offer.details.stops, 2);
  assert.match(offer.title, /\? → \?/);                       // no display codes, no carrier name
  assert.ok(offer.id.startsWith('sky-scrapper-JetBlue9'));    // id derived from segments
  assert.equal(offer.score, 50);                              // itinerary.score 0.5 scaled

  const call = fetchImpl.calls.find((c) => c.url.includes('/searchFlights'));
  const params = new URL(call.url).searchParams;
  assert.equal(params.get('cabinClass'), 'business');
  assert.equal(params.get('returnDate'), '2026-07-10');
});

test('SkyScrapperProvider skips itineraries without a numeric price and tolerates sparse legs', async () => {
  const sparse = { id: 'sparse', price: { raw: 150 }, legs: [] };
  const unpriced = { id: 'nope', price: { formatted: 'call us' }, legs: [] };
  const fetchImpl = skyFetch({ flights: { status: true, data: { itineraries: [sparse, unpriced] } } });
  const offers = await new SkyScrapperProvider({ apiKey: 'k', fetchImpl }).search('flights', { from: 'LAX', to: 'JFK' });

  assert.equal(offers.length, 1);
  assert.equal(offers[0].title, 'Flight');
  assert.equal(offers[0].details.stops, 0);
  assert.equal(offers[0].score, 100); // no itinerary score -> stop-based fallback
});

test('SkyScrapperProvider tolerates sparse airport lookups (no-exact match, no navigation, non-array data)', async () => {
  const fetchImpl = stubFetch((url) => {
    if (url.includes('/searchAirport')) {
      const q = new URL(url).searchParams.get('query');
      // Origin: skyId differs from the query (no exact match) and no navigation block.
      if (q === 'AAA') return jsonResponse({ status: true, data: [{ skyId: 'BBB', entityId: '111' }] });
      return jsonResponse({ status: true }); // Destination: no data array at all.
    }
    return jsonResponse({ status: true, data: { itineraries: [] } });
  });
  const offers = await new SkyScrapperProvider({ apiKey: 'k', fetchImpl }).search('flights', { from: 'AAA', to: 'ZZZ' });
  assert.deepEqual(offers, []); // destination unresolved -> no search
});

test('SkyScrapperProvider maps itineraries with missing legs, missing segments, and empty fields', async () => {
  const itineraries = [
    { id: 'nolegs', price: { raw: 100 } }, // no legs key -> legs default to []
    { id: 'emptyseg', price: { raw: 200 }, legs: [
      { origin: { displayCode: 'LAX' }, destination: { displayCode: 'JFK' } }, // leg without segments
      { segments: [ {} ] } // one empty segment -> every field falls back to null
    ] }
  ];
  const fetchImpl = skyFetch({ flights: { status: true, data: { itineraries } } });
  const offers = await new SkyScrapperProvider({ apiKey: 'k', fetchImpl }).search('flights', { from: 'LAX', to: 'JFK' });

  const nolegs = offers.find((o) => o.id === 'sky-scrapper-nolegs');
  assert.equal(nolegs.title, 'Flight');          // no first leg
  assert.deepEqual(nolegs.details.segments, []);  // no legs -> no segments

  const emptyseg = offers.find((o) => o.id === 'sky-scrapper-emptyseg');
  assert.equal(emptyseg.details.segments.length, 1);
  assert.deepEqual(emptyseg.details.segments[0], { carrier: null, number: null, at: null, from: null, to: null });
});

test('SkyScrapperProvider falls back to a generic reason when an error carries no message', async () => {
  const fetchImpl = skyFetch({ flights: { status: false } });
  await assert.rejects(
    new SkyScrapperProvider({ apiKey: 'k', fetchImpl }).search('flights', { from: 'LAX', to: 'JFK' }),
    /Sky-Scrapper error: request rejected/
  );
});

test('SkyScrapperProvider tolerates airport entries without a skyId and a payload with no itineraries', async () => {
  const airport = (q) => q === 'QQ'
    ? [{ entityId: 'x' }, { skyId: 'QQ', entityId: '1', navigation: { relevantFlightParams: { skyId: 'QQ', entityId: '1' } } }]
    : [{ skyId: 'WW', entityId: '2', navigation: { relevantFlightParams: { skyId: 'WW', entityId: '2' } } }];
  const fetchImpl = stubFetch((url) => url.includes('/searchAirport')
    ? jsonResponse({ status: true, data: airport(new URL(url).searchParams.get('query')) })
    : jsonResponse({ status: true, data: {} })); // both endpoints resolve, but no itineraries array
  const offers = await new SkyScrapperProvider({ apiKey: 'k', fetchImpl }).search('flights', { from: 'QQ', to: 'WW' });
  assert.deepEqual(offers, []);
});

// ---- Booking.com ------------------------------------------------------------

const vegasDestination = {
  dest_id: '20079110', search_type: 'city', dest_type: 'city', city_name: 'Las Vegas'
};
const bellagio = {
  hotel_id: 191605,
  property: {
    id: 191605,
    name: 'Bellagio',
    reviewScore: 8.7,
    reviewCount: 41219,
    accuratePropertyClass: 5,
    wishlistName: 'Las Vegas',
    latitude: 36.11,
    longitude: -115.17,
    priceBreakdown: {
      grossPrice: { currency: 'USD', value: 979.76 },
      excludedPrice: { currency: 'USD', value: 132.4 }
    }
  }
};

function bookingFetch(overrides = {}) {
  return stubFetch((url) => {
    if (url.includes('/searchDestination')) {
      return jsonResponse(overrides.destinations ?? { status: true, data: [vegasDestination] });
    }
    return jsonResponse(overrides.hotels ?? { status: true, data: { hotels: [bellagio] } });
  });
}

test('BookingComProvider is not ready without an API key and only supports hotels', () => {
  const provider = new BookingComProvider({});
  assert.equal(provider.ready, false);
  assert.equal(provider.supports('hotels'), true);
  assert.equal(provider.supports('flights'), false);
  assert.deepEqual(provider.status().supports, ['hotels']);
  assert.equal(new BookingComProvider({ apiKey: 'k' }).ready, true);
});

test('BookingComProvider returns [] for non-hotel verticals without calling out', async () => {
  const fetchImpl = bookingFetch();
  const provider = new BookingComProvider({ apiKey: 'k', fetchImpl });
  assert.deepEqual(await provider.search('flights', { from: 'LAX', to: 'JFK' }), []);
  assert.equal(fetchImpl.calls.length, 0);
});

test('BookingComProvider resolves the city, maps all-in totals, and passes stay parameters', async () => {
  const fetchImpl = bookingFetch();
  const provider = new BookingComProvider({ apiKey: 'k', fetchImpl });
  const offers = await provider.search('hotels', {
    city: 'Las Vegas', checkin: '2026-07-01', checkout: '2026-07-05', adults: '2', rooms: '1'
  });

  assert.equal(offers.length, 1);
  assert.equal(offers[0].price.total, 979.76 + 132.4);
  assert.equal(offers[0].price.fees, 132.4);
  assert.equal(offers[0].price.estimated, false);
  assert.equal(offers[0].details.hotelId, 191605);
  assert.equal(offers[0].details.location.lat, 36.11);

  const hotelCall = fetchImpl.calls.find((c) => c.url.includes('/searchHotels'));
  const params = new URL(hotelCall.url).searchParams;
  assert.equal(params.get('dest_id'), '20079110');
  assert.equal(params.get('search_type'), 'CITY');
  assert.equal(params.get('arrival_date'), '2026-07-01');
  assert.equal(params.get('departure_date'), '2026-07-05');
  assert.equal(params.get('adults'), '2');
  assert.equal(hotelCall.options.headers['X-RapidAPI-Host'], 'booking-com15.p.rapidapi.com');
});

test('BookingComProvider caches destination resolution across searches', async () => {
  const fetchImpl = bookingFetch();
  const provider = new BookingComProvider({ apiKey: 'k', fetchImpl });
  await provider.search('hotels', { city: 'Las Vegas' });
  await provider.search('hotels', { city: 'las vegas' }); // case-insensitive cache key

  const destinationCalls = fetchImpl.calls.filter((c) => c.url.includes('/searchDestination'));
  assert.equal(destinationCalls.length, 1);
});

test('BookingComProvider prefers a city destination over a landmark', async () => {
  const landmarkFirst = {
    status: true,
    data: [
      { dest_id: '900040025', search_type: 'landmark', dest_type: 'landmark', city_name: 'Las Vegas' },
      vegasDestination
    ]
  };
  const fetchImpl = bookingFetch({ destinations: landmarkFirst });
  const provider = new BookingComProvider({ apiKey: 'k', fetchImpl });
  await provider.search('hotels', { city: 'Las Vegas' });

  const hotelCall = fetchImpl.calls.find((c) => c.url.includes('/searchHotels'));
  assert.equal(new URL(hotelCall.url).searchParams.get('dest_id'), '20079110');
});

test('BookingComProvider returns [] when the city cannot be resolved', async () => {
  const fetchImpl = bookingFetch({ destinations: { status: true, data: [] } });
  const provider = new BookingComProvider({ apiKey: 'k', fetchImpl });
  assert.deepEqual(await provider.search('hotels', { city: 'Nowhereville' }), []);
  assert.deepEqual(await provider.search('hotels', {}), []);
});

test('BookingComProvider surfaces an API rejection as an error', async () => {
  const fetchImpl = bookingFetch({ hotels: { status: false, message: 'arrival_date is required' } });
  const provider = new BookingComProvider({ apiKey: 'k', fetchImpl });
  await assert.rejects(
    provider.search('hotels', { city: 'Las Vegas' }),
    /Booking\.com error: arrival_date is required/
  );
});

test('BookingComProvider skips hotels without a usable name or price', async () => {
  const nameless = { hotel_id: 1, property: { priceBreakdown: { grossPrice: { value: 100 } } } };
  const priceless = { hotel_id: 2, property: { name: 'Mystery Inn', priceBreakdown: {} } };
  const starsOnly = {
    hotel_id: 3,
    property: { name: 'Quiet Motel', propertyClass: 3, priceBreakdown: { grossPrice: { currency: 'USD', value: 88 } } }
  };
  const fetchImpl = bookingFetch({ hotels: { status: true, data: { hotels: [nameless, priceless, starsOnly] } } });
  const offers = await new BookingComProvider({ apiKey: 'k', fetchImpl }).search('hotels', { city: 'Las Vegas' });

  assert.equal(offers.length, 1);
  assert.equal(offers[0].title, 'Quiet Motel');
  assert.equal(offers[0].price.total, 88);
  assert.equal(offers[0].score, 60); // no reviews -> stars fallback (3 * 20)
  assert.equal(offers[0].details.location, null);
});

test('BookingComProvider resolves a non-city destination and maps hotel fallbacks', async () => {
  const destinations = { status: true, data: [{ dest_id: '555', dest_type: 'region' }] }; // no search_type, no city_name
  const hotels = { status: true, data: { hotels: [{
    // no hotel_id -> id from property.id; grossPrice without currency -> provider currency;
    // excludedPrice 0 -> no fee; no wishlistName -> destination.cityName; no accuratePropertyClass -> propertyClass
    property: {
      id: 999, name: 'Edge Inn', propertyClass: 3,
      priceBreakdown: { grossPrice: { value: 120 }, excludedPrice: { value: 0 } }
    }
  }] } };
  const fetchImpl = bookingFetch({ destinations, hotels });
  const offers = await new BookingComProvider({ apiKey: 'k', currency: 'EUR', fetchImpl })
    .search('hotels', { city: 'Testville' });

  assert.equal(offers.length, 1);
  const [offer] = offers;
  assert.equal(offer.id, 'booking-com-999');   // property.id fallback
  assert.equal(offer.price.currency, 'EUR');   // provider-currency fallback
  assert.equal(offer.price.fees, null);        // excluded 0 -> no fee
  assert.equal(offer.price.total, 120);
  assert.equal(offer.details.hotelId, 999);
  assert.equal(offer.details.city, 'Testville'); // destination.cityName fell back to the query
  assert.equal(offer.details.stars, 3);          // propertyClass fallback

  const call = fetchImpl.calls.find((c) => c.url.includes('/searchHotels'));
  const params = new URL(call.url).searchParams;
  assert.equal(params.get('dest_id'), '555');
  assert.equal(params.get('search_type'), 'REGION'); // dest_type upper-cased
});

test('BookingComProvider defaults the search type to CITY when none is given', async () => {
  const destinations = { status: true, data: [{ dest_id: '777' }] }; // no types at all
  const fetchImpl = bookingFetch({ destinations, hotels: { status: true, data: { hotels: [] } } });
  await new BookingComProvider({ apiKey: 'k', fetchImpl }).search('hotels', { city: 'Blankton' });

  const call = fetchImpl.calls.find((c) => c.url.includes('/searchHotels'));
  assert.equal(new URL(call.url).searchParams.get('search_type'), 'CITY');
});

test('BookingComProvider returns [] when the hotels payload has no hotel array', async () => {
  const fetchImpl = bookingFetch({ hotels: { status: true, data: {} } });
  const offers = await new BookingComProvider({ apiKey: 'k', fetchImpl }).search('hotels', { city: 'Las Vegas' });
  assert.deepEqual(offers, []);
});

test('BookingComProvider surfaces an array-form API error message', async () => {
  const fetchImpl = bookingFetch({ hotels: { status: false, message: ['field a required', { b: 1 }] } });
  await assert.rejects(
    new BookingComProvider({ apiKey: 'k', fetchImpl }).search('hotels', { city: 'Las Vegas' }),
    /Booking\.com error: field a required; /
  );
});

test('BookingComProvider returns [] when destination lookup has no data array', async () => {
  const fetchImpl = bookingFetch({ destinations: { status: true } }); // no data array
  assert.deepEqual(await new BookingComProvider({ apiKey: 'k', fetchImpl }).search('hotels', { city: 'X' }), []);
});

test('BookingComProvider skips a hotel with no price breakdown and nulls missing metadata', async () => {
  const hotels = { status: true, data: { hotels: [
    { hotel_id: 1, property: { name: 'No Price', id: 1 } }, // no priceBreakdown -> skipped
    { property: { name: 'Anon', priceBreakdown: { grossPrice: { currency: 'USD', value: 100 } } } } // no ids, no review, no class
  ] } };
  const fetchImpl = bookingFetch({ hotels });
  const offers = await new BookingComProvider({ apiKey: 'k', fetchImpl }).search('hotels', { city: 'Las Vegas' });

  assert.equal(offers.length, 1);
  assert.equal(offers[0].title, 'Anon');
  assert.equal(offers[0].details.hotelId, null); // both hotel_id and property.id missing
  assert.equal(offers[0].details.stars, null);   // no property class
  assert.equal(offers[0].score, null);           // no review score and no stars
});

test('BookingComProvider falls back to a generic reason when an error carries no message', async () => {
  const fetchImpl = bookingFetch({ hotels: { status: false } });
  await assert.rejects(
    new BookingComProvider({ apiKey: 'k', fetchImpl }).search('hotels', { city: 'Las Vegas' }),
    /Booking\.com error: request rejected/
  );
});
