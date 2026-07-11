import test from 'node:test';
import assert from 'node:assert/strict';
import { createWeather, describeWeatherCode } from '../../src/enrichment/weather.js';

// A realistic Open-Meteo geocoding payload with a single full match.
function sampleGeocodePayload() {
  return {
    results: [
      {
        id: 2988507,
        name: 'Paris',
        latitude: 48.85341,
        longitude: 2.3488,
        country: 'France',
        country_code: 'fr',
        timezone: 'Europe/Paris'
      }
    ],
    generationtime_ms: 0.5
  };
}

// A realistic Open-Meteo forecast payload. The second day carries a junk
// weather code and the wind array is one entry short, so the numeric
// coercion branches are exercised alongside the happy path.
function sampleForecastPayload() {
  return {
    latitude: 48.86,
    longitude: 2.35,
    timezone: 'Europe/Paris',
    daily: {
      time: ['2026-07-11', '2026-07-12'],
      weather_code: [61, 'junk'],
      temperature_2m_max: [24.3, 26.1],
      temperature_2m_min: [15.2, 16.8],
      precipitation_probability_max: [80, 20],
      wind_speed_10m_max: [18.7]
    }
  };
}

// A fake fetchJson matching src/utils/httpClient.js#fetchJson. It records calls
// and never touches the network.
function fakeFetchJson(result) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, options });
    return typeof result === 'function' ? result(url, options) : result;
  };
  fn.calls = calls;
  return fn;
}

test('disabled when enabled is false: geocode() and forecast() return null', async () => {
  const enricher = createWeather({ fetchJson: fakeFetchJson({}), enabled: false });
  assert.equal(enricher.enabled, false);
  assert.equal(await enricher.geocode('Paris'), null);
  assert.equal(await enricher.forecast(48.85, 2.35), null);
});

test('disabled when no fetchJson is provided even if enabled is true', async () => {
  const enricher = createWeather({ enabled: true });
  assert.equal(enricher.enabled, false);
  assert.equal(await enricher.geocode('Paris'), null);
  assert.equal(await enricher.forecast(48.85, 2.35), null);
});

test('defaults produce a disabled enricher', async () => {
  const enricher = createWeather();
  assert.equal(enricher.enabled, false);
  assert.equal(await enricher.geocode('Paris'), null);
  assert.equal(await enricher.forecast(48.85, 2.35), null);
});

test('geocode rejects a non-string city with a 400', async () => {
  const enricher = createWeather({ fetchJson: fakeFetchJson({}), enabled: true });
  await assert.rejects(() => enricher.geocode(42), (err) => {
    assert.equal(err.statusCode, 400);
    assert.match(err.message, /city must be a non-empty string of at most 120 characters/);
    return true;
  });
});

test('geocode rejects a blank city with a 400', async () => {
  const enricher = createWeather({ fetchJson: fakeFetchJson({}), enabled: true });
  await assert.rejects(() => enricher.geocode('   '), (err) => {
    assert.equal(err.statusCode, 400);
    assert.match(err.message, /city must be a non-empty string/);
    return true;
  });
});

test('geocode rejects an overlong city with a 400', async () => {
  const enricher = createWeather({ fetchJson: fakeFetchJson({}), enabled: true });
  await assert.rejects(() => enricher.geocode('x'.repeat(121)), (err) => {
    assert.equal(err.statusCode, 400);
    assert.match(err.message, /at most 120 characters/);
    return true;
  });
});

test('geocode returns a normalized match and calls the right URL', async () => {
  const fetchJson = fakeFetchJson(sampleGeocodePayload());
  const enricher = createWeather({ fetchJson, enabled: true, timeoutMs: 1234 });
  assert.equal(enricher.enabled, true);

  const result = await enricher.geocode('  New Paris  ');

  assert.deepEqual(result, {
    name: 'Paris',
    country: 'France',
    countryCode: 'FR',
    latitude: 48.85341,
    longitude: 2.3488,
    timezone: 'Europe/Paris'
  });

  // The city was trimmed and URL-encoded, and the injected options were used.
  assert.equal(fetchJson.calls.length, 1);
  assert.equal(
    fetchJson.calls[0].url,
    'https://geocoding-api.open-meteo.com/v1/search?name=New%20Paris&count=1&language=en&format=json'
  );
  assert.equal(fetchJson.calls[0].options.timeoutMs, 1234);
  assert.deepEqual(fetchJson.calls[0].options.headers, { accept: 'application/json' });
});

test('geocode falls back safely when optional fields are missing or junk', async () => {
  // name is not a string, country is missing, country_code is not a string
  // and timezone is a number: every optional field falls back.
  const fetchJson = fakeFetchJson({
    results: [{ name: 99, latitude: 1.5, longitude: -2.5, country_code: 12, timezone: 7 }]
  });
  const enricher = createWeather({ fetchJson, enabled: true });

  const result = await enricher.geocode(' Springfield ');

  assert.deepEqual(result, {
    name: 'Springfield',
    country: null,
    countryCode: null,
    latitude: 1.5,
    longitude: -2.5,
    timezone: null
  });
  // Default timeout applies when none is injected.
  assert.equal(fetchJson.calls[0].options.timeoutMs, 5000);
});

test('geocode nulls a country_code string that is not exactly two letters', async () => {
  const fetchJson = fakeFetchJson({
    results: [{ name: 'Oslo', latitude: 59.9, longitude: 10.7, country: 'Norway', country_code: 'NOR' }]
  });
  const enricher = createWeather({ fetchJson, enabled: true });

  const result = await enricher.geocode('Oslo');
  assert.equal(result.countryCode, null);
  assert.equal(result.country, 'Norway');
});

test('geocode returns null for an unknown destination (empty results)', async () => {
  const enricher = createWeather({ fetchJson: fakeFetchJson({ results: [] }), enabled: true });
  assert.equal(await enricher.geocode('Atlantis'), null);
});

test('geocode returns null when results is missing', async () => {
  const enricher = createWeather({ fetchJson: fakeFetchJson({ generationtime_ms: 0.4 }), enabled: true });
  assert.equal(await enricher.geocode('Atlantis'), null);
});

test('geocode returns null when results is not an array', async () => {
  const enricher = createWeather({ fetchJson: fakeFetchJson({ results: 'nope' }), enabled: true });
  assert.equal(await enricher.geocode('Atlantis'), null);
});

test('geocode wraps an upstream failure into a safe 502 and does not leak detail', async () => {
  const leak = new Error('ECONNREFUSED 10.0.0.5:443 secret-internal-host');
  const fetchJson = async () => { throw leak; };
  const enricher = createWeather({ fetchJson, enabled: true });

  await assert.rejects(() => enricher.geocode('Paris'), (err) => {
    assert.equal(err.statusCode, 502);
    assert.equal(err.message, 'Destination lookup is unavailable right now. Please try again later.');
    assert.doesNotMatch(err.message, /ECONNREFUSED|10\.0\.0\.5|secret-internal-host/);
    assert.equal(err.cause, leak); // detail preserved for logs, not for the client
    return true;
  });
});

test('geocode wraps a null payload into a 502', async () => {
  const enricher = createWeather({ fetchJson: fakeFetchJson(null), enabled: true });
  await assert.rejects(() => enricher.geocode('Paris'), (err) => {
    assert.equal(err.statusCode, 502);
    assert.equal(err.message, 'Destination lookup response was malformed.');
    return true;
  });
});

test('geocode wraps a non-object payload into a 502', async () => {
  const enricher = createWeather({ fetchJson: fakeFetchJson('not-json-object'), enabled: true });
  await assert.rejects(() => enricher.geocode('Paris'), (err) => {
    assert.equal(err.statusCode, 502);
    assert.match(err.message, /malformed/);
    return true;
  });
});

test('geocode wraps an array payload into a 502 (arrays are not plain objects)', async () => {
  const enricher = createWeather({ fetchJson: fakeFetchJson([1, 2, 3]), enabled: true });
  await assert.rejects(() => enricher.geocode('Paris'), (err) => {
    assert.equal(err.statusCode, 502);
    assert.match(err.message, /malformed/);
    return true;
  });
});

test('geocode wraps a match with a non-numeric latitude into a 502', async () => {
  const fetchJson = fakeFetchJson({ results: [{ name: 'Paris', latitude: 'north', longitude: 2.35 }] });
  const enricher = createWeather({ fetchJson, enabled: true });
  await assert.rejects(() => enricher.geocode('Paris'), (err) => {
    assert.equal(err.statusCode, 502);
    assert.match(err.message, /malformed/);
    return true;
  });
});

test('geocode wraps a match with a missing longitude into a 502', async () => {
  const fetchJson = fakeFetchJson({ results: [{ name: 'Paris', latitude: 48.85 }] });
  const enricher = createWeather({ fetchJson, enabled: true });
  await assert.rejects(() => enricher.geocode('Paris'), (err) => {
    assert.equal(err.statusCode, 502);
    assert.match(err.message, /malformed/);
    return true;
  });
});

test('forecast rejects a non-numeric latitude with a 400', async () => {
  const enricher = createWeather({ fetchJson: fakeFetchJson({}), enabled: true });
  await assert.rejects(() => enricher.forecast('48.85', 2.35), (err) => {
    assert.equal(err.statusCode, 400);
    assert.match(err.message, /latitude must be a finite number between -90 and 90/);
    return true;
  });
});

test('forecast rejects out-of-range latitudes with a 400', async () => {
  const enricher = createWeather({ fetchJson: fakeFetchJson({}), enabled: true });
  await assert.rejects(() => enricher.forecast(-90.1, 0), (err) => {
    assert.equal(err.statusCode, 400);
    return true;
  });
  await assert.rejects(() => enricher.forecast(90.1, 0), (err) => {
    assert.equal(err.statusCode, 400);
    return true;
  });
});

test('forecast rejects a non-numeric longitude with a 400', async () => {
  const enricher = createWeather({ fetchJson: fakeFetchJson({}), enabled: true });
  await assert.rejects(() => enricher.forecast(48.85, null), (err) => {
    assert.equal(err.statusCode, 400);
    assert.match(err.message, /longitude must be a finite number between -180 and 180/);
    return true;
  });
});

test('forecast rejects out-of-range longitudes with a 400', async () => {
  const enricher = createWeather({ fetchJson: fakeFetchJson({}), enabled: true });
  await assert.rejects(() => enricher.forecast(0, -180.1), (err) => {
    assert.equal(err.statusCode, 400);
    return true;
  });
  await assert.rejects(() => enricher.forecast(0, 180.1), (err) => {
    assert.equal(err.statusCode, 400);
    return true;
  });
});

test('forecast rejects a non-integer days option with a 400', async () => {
  const enricher = createWeather({ fetchJson: fakeFetchJson({}), enabled: true });
  await assert.rejects(() => enricher.forecast(0, 0, { days: 2.5 }), (err) => {
    assert.equal(err.statusCode, 400);
    assert.match(err.message, /days must be an integer between 1 and 10/);
    return true;
  });
});

test('forecast rejects out-of-range days with a 400', async () => {
  const enricher = createWeather({ fetchJson: fakeFetchJson({}), enabled: true });
  await assert.rejects(() => enricher.forecast(0, 0, { days: 0 }), (err) => {
    assert.equal(err.statusCode, 400);
    return true;
  });
  await assert.rejects(() => enricher.forecast(0, 0, { days: 11 }), (err) => {
    assert.equal(err.statusCode, 400);
    return true;
  });
});

test('forecast returns a normalized, clearly labeled result on success', async () => {
  const fetchJson = fakeFetchJson(sampleForecastPayload());
  const enricher = createWeather({
    fetchJson,
    enabled: true,
    timeoutMs: 1234,
    now: () => 1_700_000_000_000
  });

  const result = await enricher.forecast(48.85, 2.35, { days: 2 });

  assert.equal(result.source, 'Open-Meteo (enrichment only)');
  assert.equal(result.latitude, 48.85);
  assert.equal(result.longitude, 2.35);
  assert.equal(result.timezone, 'Europe/Paris');
  assert.equal(result.fetchedAt, new Date(1_700_000_000_000).toISOString());
  assert.equal(result.days.length, 2);

  // Day 1: every daily array has a finite number at index 0.
  assert.deepEqual(result.days[0], {
    date: '2026-07-11',
    weatherCode: 61,
    description: 'rain',
    tempMaxC: 24.3,
    tempMinC: 15.2,
    precipitationChance: 80,
    windMaxKmh: 18.7
  });

  // Day 2: the junk weather code and the too-short wind array become null.
  assert.deepEqual(result.days[1], {
    date: '2026-07-12',
    weatherCode: null,
    description: 'unknown',
    tempMaxC: 26.1,
    tempMinC: 16.8,
    precipitationChance: 20,
    windMaxKmh: null
  });

  // The upstream call used the injected client with the right URL and options.
  assert.equal(fetchJson.calls.length, 1);
  assert.equal(
    fetchJson.calls[0].url,
    'https://api.open-meteo.com/v1/forecast?latitude=48.85&longitude=2.35' +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max' +
      '&timezone=auto&forecast_days=2'
  );
  assert.equal(fetchJson.calls[0].options.timeoutMs, 1234);
  assert.deepEqual(fetchJson.calls[0].options.headers, { accept: 'application/json' });
});

test('forecast defaults to 5 days and the default clock when not injected', async () => {
  const before = Date.now();
  const fetchJson = fakeFetchJson({ daily: { time: [] } });
  const enricher = createWeather({ fetchJson, enabled: true });

  const result = await enricher.forecast(10, 20);

  assert.match(fetchJson.calls[0].url, /&forecast_days=5$/);
  assert.deepEqual(result.days, []);
  // No timezone string in the payload falls back to null.
  assert.equal(result.timezone, null);
  const stamp = Date.parse(result.fetchedAt);
  assert.ok(stamp >= before && stamp <= Date.now());
});

test('forecast nulls every numeric field when the daily arrays are missing', async () => {
  const fetchJson = fakeFetchJson({ timezone: 'UTC', daily: { time: ['2026-07-11'] } });
  const enricher = createWeather({ fetchJson, enabled: true });

  const result = await enricher.forecast(0, 0, { days: 1 });

  assert.deepEqual(result.days, [
    {
      date: '2026-07-11',
      weatherCode: null,
      description: 'unknown',
      tempMaxC: null,
      tempMinC: null,
      precipitationChance: null,
      windMaxKmh: null
    }
  ]);
  assert.equal(result.timezone, 'UTC');
});

test('forecast wraps an upstream failure into a safe 502 and does not leak detail', async () => {
  const leak = new Error('socket hang up at internal-weather-proxy:8443');
  const fetchJson = async () => { throw leak; };
  const enricher = createWeather({ fetchJson, enabled: true });

  await assert.rejects(() => enricher.forecast(48.85, 2.35), (err) => {
    assert.equal(err.statusCode, 502);
    assert.equal(err.message, 'Weather is unavailable right now. Please try again later.');
    assert.doesNotMatch(err.message, /socket hang up|internal-weather-proxy/);
    assert.equal(err.cause, leak);
    return true;
  });
});

test('forecast wraps a non-object payload into a 502', async () => {
  const enricher = createWeather({ fetchJson: fakeFetchJson(null), enabled: true });
  await assert.rejects(() => enricher.forecast(0, 0), (err) => {
    assert.equal(err.statusCode, 502);
    assert.equal(err.message, 'Weather response was malformed.');
    return true;
  });
});

test('forecast wraps a missing daily block into a 502', async () => {
  const enricher = createWeather({ fetchJson: fakeFetchJson({ timezone: 'UTC' }), enabled: true });
  await assert.rejects(() => enricher.forecast(0, 0), (err) => {
    assert.equal(err.statusCode, 502);
    assert.match(err.message, /malformed/);
    return true;
  });
});

test('forecast wraps a non-array daily.time into a 502', async () => {
  const enricher = createWeather({ fetchJson: fakeFetchJson({ daily: { time: 'tomorrow' } }), enabled: true });
  await assert.rejects(() => enricher.forecast(0, 0), (err) => {
    assert.equal(err.statusCode, 502);
    assert.match(err.message, /malformed/);
    return true;
  });
});

test('describeWeatherCode maps every documented WMO bucket', () => {
  const expected = {
    0: 'clear sky',
    1: 'mostly clear',
    2: 'partly cloudy',
    3: 'overcast',
    45: 'fog',
    48: 'fog',
    51: 'drizzle',
    53: 'drizzle',
    55: 'drizzle',
    56: 'freezing drizzle',
    57: 'freezing drizzle',
    61: 'rain',
    63: 'rain',
    65: 'rain',
    66: 'freezing rain',
    67: 'freezing rain',
    71: 'snow',
    73: 'snow',
    75: 'snow',
    77: 'snow',
    80: 'rain showers',
    81: 'rain showers',
    82: 'rain showers',
    85: 'snow showers',
    86: 'snow showers',
    95: 'thunderstorm',
    96: 'thunderstorm with hail',
    99: 'thunderstorm with hail'
  };
  for (const [code, phrase] of Object.entries(expected)) {
    assert.equal(describeWeatherCode(Number(code)), phrase);
  }
});

test('describeWeatherCode falls back to unknown for anything else', () => {
  assert.equal(describeWeatherCode(42), 'unknown'); // finite but unmapped
  assert.equal(describeWeatherCode(-1), 'unknown');
  assert.equal(describeWeatherCode(null), 'unknown');
  assert.equal(describeWeatherCode(undefined), 'unknown');
  assert.equal(describeWeatherCode('clear'), 'unknown');
  assert.equal(describeWeatherCode(Number.NaN), 'unknown');
});
