import test from 'node:test';
import assert from 'node:assert/strict';
import { createConcierge } from '../../src/enrichment/concierge.js';

// All source modules are small fakes honoring the injected contracts; the
// concierge never imports its siblings and these tests never touch the
// network. Each fake records its calls and its `result` option may be a
// value, or a function (which may throw) for failure scenarios.

const FIXED_NOW = Date.UTC(2026, 6, 4, 12, 0, 0); // 2026-07-04T12:00:00Z

function sampleGeo(overrides = {}) {
  return {
    name: 'Vienna',
    country: 'Austria',
    countryCode: 'AT',
    latitude: 48.21,
    longitude: 16.37,
    timezone: 'Europe/Vienna',
    ...overrides
  };
}

function resolveResult(result) {
  return typeof result === 'function' ? result() : result;
}

function fakeWeather({ enabled = true, geocodeResult = sampleGeo(), forecastResult = null } = {}) {
  const geocodeCalls = [];
  const forecastCalls = [];
  return {
    enabled,
    geocodeCalls,
    forecastCalls,
    async geocode(city) {
      geocodeCalls.push(city);
      return resolveResult(geocodeResult);
    },
    async forecast(latitude, longitude, options) {
      forecastCalls.push({ latitude, longitude, options });
      return resolveResult(forecastResult);
    }
  };
}

function fakePlaces({ enabled = true, result = null } = {}) {
  const calls = [];
  return {
    enabled,
    calls,
    async nearby(latitude, longitude, options) {
      calls.push({ latitude, longitude, options });
      return resolveResult(result);
    }
  };
}

function fakeGuides({ enabled = true, result = null } = {}) {
  const calls = [];
  return {
    enabled,
    calls,
    async guide(destination) {
      calls.push(destination);
      return resolveResult(result);
    }
  };
}

function fakeHolidays({ enabled = true, result = null } = {}) {
  const calls = [];
  return {
    enabled,
    calls,
    async holidays(countryCode, year) {
      calls.push({ countryCode, year });
      return resolveResult(result);
    }
  };
}

test('defaults produce a disabled concierge: lookup() returns null', async () => {
  const concierge = createConcierge();
  assert.equal(concierge.enabled, false);
  assert.equal(await concierge.lookup('Vienna'), null);
});

test('disabled when the weather module itself is disabled', async () => {
  const weather = fakeWeather({ enabled: false });
  const concierge = createConcierge({ weather });
  assert.equal(concierge.enabled, false);
  assert.equal(await concierge.lookup('Vienna'), null);
  // A disabled concierge never even geocodes.
  assert.equal(weather.geocodeCalls.length, 0);
});

test('a geocode error propagates untouched with its statusCode intact', async () => {
  const upstream = new Error('Weather is unavailable right now. Please try again later.');
  upstream.statusCode = 502;
  const weather = fakeWeather({ geocodeResult: () => { throw upstream; } });
  const concierge = createConcierge({ weather });

  await assert.rejects(() => concierge.lookup('Vienna'), (err) => {
    assert.equal(err, upstream); // the very same instance, not a rewrap
    assert.equal(err.statusCode, 502);
    return true;
  });
});

test('a geocode miss becomes a 404 with a friendly message', async () => {
  const weather = fakeWeather({ geocodeResult: null });
  const concierge = createConcierge({ weather });

  await assert.rejects(() => concierge.lookup('Atlantis'), (err) => {
    assert.equal(err.statusCode, 404);
    assert.equal(err.message, 'No destination matched that name. Try a nearby major city.');
    return true;
  });
});

test('full briefing: all four sections ok, upstream attribution used verbatim', async () => {
  const forecastData = { source: 'open-meteo', latitude: 48.21, longitude: 16.37, timezone: 'Europe/Vienna', days: [], fetchedAt: 'x' };
  const placesData = { source: 'overpass', attribution: 'Custom places credit', category: 'eat', radiusM: 2000, count: 1, places: [{}], fetchedAt: 'x' };
  const guideData = { source: 'wikivoyage', attribution: 'Custom guide credit', title: 'Vienna', summary: 'Waltz on.', url: 'https://example.test', fetchedAt: 'x' };
  const holidaysData = { source: 'nager', countryCode: 'AT', year: 2026, count: 1, holidays: [{}], fetchedAt: 'x' };

  const weather = fakeWeather({ forecastResult: forecastData });
  const places = fakePlaces({ result: placesData });
  const guides = fakeGuides({ result: guideData });
  const holidays = fakeHolidays({ result: holidaysData });
  const concierge = createConcierge({ weather, places, guides, holidays, now: () => FIXED_NOW });
  assert.equal(concierge.enabled, true);

  const briefing = await concierge.lookup('  vienna  ', { category: 'eat' });

  // Destination echoes the raw query plus the geocoded facts.
  assert.deepEqual(briefing.destination, {
    query: '  vienna  ',
    name: 'Vienna',
    country: 'Austria',
    countryCode: 'AT',
    latitude: 48.21,
    longitude: 16.37,
    timezone: 'Europe/Vienna'
  });

  assert.deepEqual(briefing.sections.weather, { status: 'ok', data: forecastData });
  assert.deepEqual(briefing.sections.places, { status: 'ok', data: placesData });
  assert.deepEqual(briefing.sections.guide, { status: 'ok', data: guideData });
  assert.deepEqual(briefing.sections.holidays, { status: 'ok', data: holidaysData });

  // Attribution honors upstream strings and keeps the fixed order.
  assert.deepEqual(briefing.attribution, [
    'Weather by Open-Meteo.com',
    'Custom places credit',
    'Custom guide credit',
    'Public holidays from Nager.Date'
  ]);

  assert.equal(briefing.fetchedAt, new Date(FIXED_NOW).toISOString());

  // Each source was called with the values the contract promises.
  assert.equal(weather.geocodeCalls[0], '  vienna  ');
  assert.deepEqual(weather.forecastCalls[0], { latitude: 48.21, longitude: 16.37, options: undefined });
  assert.deepEqual(places.calls[0], { latitude: 48.21, longitude: 16.37, options: { category: 'eat' } });
  assert.deepEqual(guides.calls[0], 'Vienna');
  assert.deepEqual(holidays.calls[0], { countryCode: 'AT', year: 2026 });
});

test('attribution falls back to standard credits when sources omit theirs', async () => {
  const weather = fakeWeather({ forecastResult: { days: [] } });
  const places = fakePlaces({ result: { count: 0, places: [] } }); // no attribution field
  const guides = fakeGuides({ result: { title: 'Vienna', attribution: 42 } }); // non-string
  const holidays = fakeHolidays({ result: { count: 0, holidays: [] } });
  const concierge = createConcierge({ weather, places, guides, holidays, now: () => FIXED_NOW });

  const briefing = await concierge.lookup('Vienna');

  assert.deepEqual(briefing.attribution, [
    'Weather by Open-Meteo.com',
    'Map data (c) OpenStreetMap contributors (ODbL 1.0)',
    'Guide text from Wikivoyage, CC BY-SA 4.0',
    'Public holidays from Nager.Date'
  ]);
});

test('category defaults to see when no options are passed', async () => {
  const weather = fakeWeather();
  const places = fakePlaces({ result: { count: 0 } });
  const concierge = createConcierge({ weather, places });

  await concierge.lookup('Vienna');

  assert.deepEqual(places.calls[0].options, { category: 'see' });
});

test('fulfilled-null sources become empty sections and earn no attribution', async () => {
  const weather = fakeWeather({ forecastResult: null });
  const places = fakePlaces({ result: null });
  const guides = fakeGuides({ result: null });
  const holidays = fakeHolidays({ result: null });
  const concierge = createConcierge({ weather, places, guides, holidays, now: () => FIXED_NOW });

  const briefing = await concierge.lookup('Vienna');

  assert.deepEqual(briefing.sections.weather, { status: 'empty', data: null });
  assert.deepEqual(briefing.sections.places, { status: 'empty', data: null });
  assert.deepEqual(briefing.sections.guide, { status: 'empty', data: null });
  assert.deepEqual(briefing.sections.holidays, { status: 'empty', data: null });
  assert.deepEqual(briefing.attribution, []);
});

test('rejected sources become unavailable sections without sinking the briefing', async () => {
  // Four distinct rejection reasons exercise every message branch:
  //   - Error with a real message: surfaced verbatim
  //   - falsy reason (null): generic message
  //   - object without a message string: generic message
  //   - Error with an empty message: generic message
  const weather = fakeWeather({ forecastResult: () => { throw new Error('Forecast melted'); } });
  const places = fakePlaces({ result: () => { throw null; } });
  const guides = fakeGuides({ result: () => { throw { code: 'EWEIRD' }; } });
  const holidays = fakeHolidays({ result: () => { throw new Error(''); } });
  const concierge = createConcierge({ weather, places, guides, holidays, now: () => FIXED_NOW });

  const briefing = await concierge.lookup('Vienna');

  assert.deepEqual(briefing.sections.weather, {
    status: 'unavailable',
    data: null,
    message: 'Forecast melted'
  });
  assert.deepEqual(briefing.sections.places, {
    status: 'unavailable',
    data: null,
    message: 'This source is unavailable right now.'
  });
  assert.deepEqual(briefing.sections.guide, {
    status: 'unavailable',
    data: null,
    message: 'This source is unavailable right now.'
  });
  assert.deepEqual(briefing.sections.holidays, {
    status: 'unavailable',
    data: null,
    message: 'This source is unavailable right now.'
  });
  assert.deepEqual(briefing.attribution, []);
  // The briefing itself still stands even though every garnish failed.
  assert.equal(briefing.destination.name, 'Vienna');
});

test('one failed garnish leaves the other sections intact', async () => {
  const weather = fakeWeather({ forecastResult: { days: [] } });
  const places = fakePlaces({ result: () => { throw new Error('Overpass timed out'); } });
  const guides = fakeGuides({ result: { title: 'Vienna', attribution: 'Guide credit' } });
  const concierge = createConcierge({ weather, places, guides });

  const briefing = await concierge.lookup('Vienna');

  assert.equal(briefing.sections.weather.status, 'ok');
  assert.equal(briefing.sections.places.status, 'unavailable');
  assert.equal(briefing.sections.places.message, 'Overpass timed out');
  assert.equal(briefing.sections.guide.status, 'ok');
  assert.equal(briefing.sections.holidays.status, 'disabled');
  // Places contributed nothing, so it earns no attribution slot.
  assert.deepEqual(briefing.attribution, ['Weather by Open-Meteo.com', 'Guide credit']);
});

test('absent garnish modules yield disabled sections', async () => {
  const weather = fakeWeather({ forecastResult: { days: [] } });
  const concierge = createConcierge({ weather });

  const briefing = await concierge.lookup('Vienna');

  assert.deepEqual(briefing.sections.places, { status: 'disabled', data: null });
  assert.deepEqual(briefing.sections.guide, { status: 'disabled', data: null });
  assert.deepEqual(briefing.sections.holidays, { status: 'disabled', data: null });
  assert.deepEqual(briefing.attribution, ['Weather by Open-Meteo.com']);
});

test('switched-off garnish modules yield disabled sections and are never called', async () => {
  const weather = fakeWeather({ forecastResult: { days: [] } });
  const places = fakePlaces({ enabled: false, result: { count: 3 } });
  const guides = fakeGuides({ enabled: false, result: { title: 'x' } });
  const holidays = fakeHolidays({ enabled: false, result: { count: 1 } });
  const concierge = createConcierge({ weather, places, guides, holidays });

  const briefing = await concierge.lookup('Vienna');

  assert.deepEqual(briefing.sections.places, { status: 'disabled', data: null });
  assert.deepEqual(briefing.sections.guide, { status: 'disabled', data: null });
  assert.deepEqual(briefing.sections.holidays, { status: 'disabled', data: null });
  assert.equal(places.calls.length, 0);
  assert.equal(guides.calls.length, 0);
  assert.equal(holidays.calls.length, 0);
});

test('enabled holidays with no countryCode: unavailable, module never called', async () => {
  const weather = fakeWeather({ geocodeResult: sampleGeo({ countryCode: null }) });
  const holidays = fakeHolidays({ result: { count: 1 } });
  const concierge = createConcierge({ weather, holidays });

  const briefing = await concierge.lookup('Vienna');

  assert.deepEqual(briefing.sections.holidays, {
    status: 'unavailable',
    data: null,
    message: 'No country code is known for this destination.'
  });
  assert.equal(holidays.calls.length, 0);
});

test('enabled holidays with an empty countryCode string: unavailable, module never called', async () => {
  const weather = fakeWeather({ geocodeResult: sampleGeo({ countryCode: '' }) });
  const holidays = fakeHolidays({ result: { count: 1 } });
  const concierge = createConcierge({ weather, holidays });

  const briefing = await concierge.lookup('Vienna');

  assert.deepEqual(briefing.sections.holidays, {
    status: 'unavailable',
    data: null,
    message: 'No country code is known for this destination.'
  });
  assert.equal(holidays.calls.length, 0);
});

test('the holidays year comes from the injected clock, not the wall clock', async () => {
  const future = Date.UTC(2031, 11, 31, 23, 59, 59);
  const weather = fakeWeather();
  const holidays = fakeHolidays({ result: { count: 0 } });
  const concierge = createConcierge({ weather, holidays, now: () => future });

  const briefing = await concierge.lookup('Vienna');

  assert.deepEqual(holidays.calls[0], { countryCode: 'AT', year: 2031 });
  assert.equal(briefing.fetchedAt, new Date(future).toISOString());
});

test('uses the default clock for fetchedAt when now is not injected', async () => {
  const before = Date.now();
  const concierge = createConcierge({ weather: fakeWeather() });
  const briefing = await concierge.lookup('Vienna');
  const stamp = Date.parse(briefing.fetchedAt);
  assert.ok(stamp >= before && stamp <= Date.now());
});
