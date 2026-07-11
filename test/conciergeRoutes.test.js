import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { brand } from '../src/config/brand.js';
import { handleRequest } from '../src/routes/router.js';
import { createWeather } from '../src/enrichment/weather.js';
import { createPlaces } from '../src/enrichment/places.js';
import { createGuides } from '../src/enrichment/guides.js';
import { createPublicHolidays } from '../src/enrichment/publicHolidays.js';
import { createConcierge } from '../src/enrichment/concierge.js';

const logger = { info() {}, warn() {}, error() {}, debug() {} };
const engine = {
  search: async () => ({}), flexibleSearch: async () => ({}), readiness: () => ({ ok: true }),
  metricsSnapshot: () => ({}), priceHistorySnapshot: () => ({}), createAlert: () => ({}), listAlerts: () => ({}), deleteAlert: () => ({})
};

// One fake upstream that answers all four keyless sources by URL, the same way
// server.js wires the real fetchJson into every module.
function upstream(overrides = {}) {
  return async (url) => {
    if (url.includes('geocoding-api.open-meteo.com')) {
      if (overrides.geocode) return overrides.geocode(url);
      return { results: [{ name: 'Lisbon', country: 'Portugal', country_code: 'pt', latitude: 38.72, longitude: -9.14, timezone: 'Europe/Lisbon' }] };
    }
    if (url.includes('api.open-meteo.com')) {
      if (overrides.forecast) return overrides.forecast(url);
      return { timezone: 'Europe/Lisbon', daily: { time: ['2026-07-12'], weather_code: [0], temperature_2m_max: [28], temperature_2m_min: [19], precipitation_probability_max: [5], wind_speed_10m_max: [14] } };
    }
    if (url.includes('overpass-api.de')) {
      if (overrides.places) return overrides.places(url);
      return { elements: [{ type: 'node', id: 42, lat: 38.71, lon: -9.13, tags: { name: 'Castelo de S. Jorge', tourism: 'attraction' } }] };
    }
    if (url.includes('wikivoyage.org')) {
      if (overrides.guide) return overrides.guide(url);
      return { query: { pages: [{ title: 'Lisbon', extract: 'Lisbon is the capital of Portugal.' }] } };
    }
    if (url.includes('date.nager.at')) {
      if (overrides.holidays) return overrides.holidays(url);
      return [{ date: '2026-06-10', localName: 'Dia de Portugal', name: 'Portugal Day', countryCode: 'PT', global: true, types: ['Public'] }];
    }
    throw new Error(`Unexpected upstream URL: ${url}`);
  };
}

function makeConcierge({ enabled = true, holidaysEnabled = true, overrides = {} } = {}) {
  const fetchJson = upstream(overrides);
  const weather = createWeather({ fetchJson, enabled });
  const places = createPlaces({ fetchJson, enabled });
  const guides = createGuides({ fetchJson, enabled });
  const holidays = createPublicHolidays({ fetchJson, enabled: holidaysEnabled });
  return createConcierge({ weather, places, guides, holidays, now: () => Date.parse('2026-07-11T12:00:00Z') });
}

async function withServer(concierge, fn) {
  const config = { allowedOrigins: ['*'], requireApiKey: false, apiKeys: [], trustProxyHops: 0 };
  const server = createServer((req, res) => handleRequest(req, res, { engine, brand, logger, config, concierge }));
  server.listen(0);
  await once(server, 'listening');
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); await once(server, 'close'); }
}

test('a full concierge briefing composes all four sources', async () => {
  await withServer(makeConcierge(), async (base) => {
    const res = await fetch(`${base}/v1/concierge?city=Lisbon`);
    assert.equal(res.status, 200);
    const { data } = await res.json();
    assert.equal(data.destination.name, 'Lisbon');
    assert.equal(data.destination.countryCode, 'PT');
    assert.equal(data.sections.weather.status, 'ok');
    assert.equal(data.sections.weather.data.days[0].description, 'clear sky');
    assert.equal(data.sections.places.status, 'ok');
    assert.equal(data.sections.places.data.places[0].name, 'Castelo de S. Jorge');
    assert.equal(data.sections.guide.status, 'ok');
    assert.match(data.sections.guide.data.url, /wikivoyage\.org/);
    assert.equal(data.sections.holidays.status, 'ok');
    assert.equal(data.sections.holidays.data.year, 2026);
    assert.equal(data.attribution.length, 4);
  });
});

test('the category query parameter reaches the places source', async () => {
  const seen = [];
  const overrides = { places: (url) => { seen.push(decodeURIComponent(url)); return { elements: [] }; } };
  await withServer(makeConcierge({ overrides }), async (base) => {
    const res = await fetch(`${base}/v1/concierge?city=Lisbon&category=eat`);
    assert.equal(res.status, 200);
    assert.match(seen[0], /amenity"="restaurant/);
    const { data } = await res.json();
    assert.equal(data.sections.places.status, 'ok');
    assert.equal(data.sections.places.data.count, 0);
  });
});

test('one failed source never sinks the briefing (honest per-section status)', async () => {
  const overrides = { places: () => { throw new Error('overpass down'); }, guide: () => ({ query: { pages: [{ missing: true }] } }) };
  await withServer(makeConcierge({ overrides }), async (base) => {
    const res = await fetch(`${base}/v1/concierge?city=Lisbon`);
    assert.equal(res.status, 200);
    const { data } = await res.json();
    assert.equal(data.sections.weather.status, 'ok');
    assert.equal(data.sections.places.status, 'unavailable');
    assert.equal(data.sections.guide.status, 'empty');
    assert.equal(data.sections.holidays.status, 'ok');
    // Attribution only lists sources that actually delivered.
    assert.equal(data.attribution.length, 2);
  });
});

test('an unknown destination is a 404, a missing city a 400, disabled a 404', async () => {
  const overrides = { geocode: () => ({ results: [] }) };
  await withServer(makeConcierge({ overrides }), async (base) => {
    const res = await fetch(`${base}/v1/concierge?city=Nowhereville`);
    assert.equal(res.status, 404);
    assert.match((await res.json()).error.message, /No destination matched/);
  });
  await withServer(makeConcierge(), async (base) => {
    assert.equal((await fetch(`${base}/v1/concierge`)).status, 400);
  });
  await withServer(makeConcierge({ enabled: false }), async (base) => {
    assert.equal((await fetch(`${base}/v1/concierge?city=Lisbon`)).status, 404);
  });
  await withServer(null, async (base) => {
    assert.equal((await fetch(`${base}/v1/concierge?city=Lisbon`)).status, 404);
  });
});

test('a geocoding outage surfaces as an honest 502 and bad input as 400', async () => {
  const overrides = { geocode: () => { throw new Error('meteo down'); } };
  await withServer(makeConcierge({ overrides }), async (base) => {
    const res = await fetch(`${base}/v1/concierge?city=Lisbon`);
    assert.equal(res.status, 502);
    assert.match((await res.json()).error.message, /Destination lookup is unavailable/);
  });
  await withServer(makeConcierge(), async (base) => {
    const res = await fetch(`${base}/v1/concierge?city=nope&category=bogus`);
    assert.equal(res.status, 400);
  });
});

test('the service index and 404 route list advertise the concierge', async () => {
  await withServer(makeConcierge(), async (base) => {
    const index = await (await fetch(`${base}/`, { headers: { accept: 'application/json' } })).json();
    assert.equal(index.data.endpoints.concierge, '/v1/concierge?city=Lisbon');
    const missing = await (await fetch(`${base}/v1/definitely-not-a-route`)).json();
    assert.ok(missing.error.details.availableRoutes.includes('/v1/concierge'));
  });
});
