// Weather enrichment backed by the Open-Meteo free weather API.
//
//   API:      Open-Meteo (geocoding + daily forecast)
//   Base URLs: https://geocoding-api.open-meteo.com/v1/search
//              https://api.open-meteo.com/v1/forecast
//   Access:   FREE and KEYLESS (no registration, no API key, no auth header).
//
// Open-Meteo (https://open-meteo.com) is a well-known, honestly free and
// keyless weather API. It complements the existing keyless enrichers (the
// Frankfurter currency converter in src/utils/currency.js and the Nager.Date
// holidays enricher in src/enrichment/publicHolidays.js) without duplicating
// either of them.
//
// ENRICHMENT ONLY. This module provides travel context (a short daily weather
// outlook for a destination) and MUST NEVER be used for pricing, ranking,
// booking, money movement, or compliance decisions. It only reads and returns
// a small, clearly labeled slice of forecast facts.
//
// Contract:
//   - When `enabled` is false OR no `fetchJson` is provided, every call returns
//     null (a disabled marker). Callers treat null as "no enrichment available"
//     and carry on without inventing data.
//   - Bad input throws an Error with `.statusCode = 400`.
//   - Any upstream failure or malformed response is wrapped into an Error with
//     `.statusCode = 502` and a safe, generic message. Upstream error detail is
//     kept only on `.cause` and never placed in the client-facing message.

const GEOCODE_BASE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_BASE_URL = 'https://api.open-meteo.com/v1/forecast';
const SOURCE_LABEL = 'Open-Meteo (enrichment only)';
const MAX_CITY_LENGTH = 120;
const MIN_FORECAST_DAYS = 1;
const MAX_FORECAST_DAYS = 10;
const DAILY_FIELDS = 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max';

// Short lowercase phrases for the WMO weather interpretation codes that
// Open-Meteo returns in `daily.weather_code`.
const WEATHER_CODE_LABELS = {
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

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function badGateway(message, cause) {
  const err = new Error(message);
  err.statusCode = 502;
  if (cause) err.cause = cause;
  return err;
}

// True for a plain JSON object payload, false for null, arrays and scalars.
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Read one numeric entry out of an upstream daily array. Anything that is not
// a finite number (missing array, short array, junk entry) becomes null so the
// caller never surfaces NaN or invented data.
function numberAt(list, index) {
  if (!Array.isArray(list)) return null;
  const value = list[index];
  return Number.isFinite(value) ? value : null;
}

// Map a WMO weather code to a short lowercase phrase. Unknown codes and
// non-numeric input (including null) fall back to 'unknown'.
export function describeWeatherCode(code) {
  if (!Number.isFinite(code)) return 'unknown';
  const label = WEATHER_CODE_LABELS[code];
  return typeof label === 'string' ? label : 'unknown';
}

function normalizeCity(raw) {
  if (typeof raw !== 'string') {
    throw badRequest(`city must be a non-empty string of at most ${MAX_CITY_LENGTH} characters`);
  }
  const city = raw.trim();
  if (city.length < 1 || city.length > MAX_CITY_LENGTH) {
    throw badRequest(`city must be a non-empty string of at most ${MAX_CITY_LENGTH} characters`);
  }
  return city;
}

function normalizeLatitude(raw) {
  if (!Number.isFinite(raw) || raw < -90 || raw > 90) {
    throw badRequest('latitude must be a finite number between -90 and 90');
  }
  return raw;
}

function normalizeLongitude(raw) {
  if (!Number.isFinite(raw) || raw < -180 || raw > 180) {
    throw badRequest('longitude must be a finite number between -180 and 180');
  }
  return raw;
}

function normalizeDays(raw) {
  if (!Number.isInteger(raw) || raw < MIN_FORECAST_DAYS || raw > MAX_FORECAST_DAYS) {
    throw badRequest(`days must be an integer between ${MIN_FORECAST_DAYS} and ${MAX_FORECAST_DAYS}`);
  }
  return raw;
}

// Factory. `fetchJson` is injected so tests never touch the network; it must
// share the signature of src/utils/httpClient.js#fetchJson.
export function createWeather({
  fetchJson = null,
  enabled = false,
  timeoutMs = 5000,
  now = () => Date.now()
} = {}) {
  const client = typeof fetchJson === 'function' ? fetchJson : null;
  const active = enabled === true && client !== null;

  // Resolve a city name to coordinates via the Open-Meteo geocoder.
  // Returns null when the enricher is disabled OR when the destination is
  // simply unknown (an unknown destination is not an error). Throws a
  // 400-style Error on bad input and a 502-style Error on upstream problems.
  async function geocode(city) {
    if (!active) return null;

    const query = normalizeCity(city);

    let payload;
    try {
      payload = await client(
        `${GEOCODE_BASE_URL}?name=${encodeURIComponent(query)}&count=1&language=en&format=json`,
        { timeoutMs, headers: { accept: 'application/json' } }
      );
    } catch (err) {
      throw badGateway('Destination lookup is unavailable right now. Please try again later.', err);
    }

    if (!isPlainObject(payload)) {
      throw badGateway('Destination lookup response was malformed.');
    }

    const results = payload.results;
    if (!Array.isArray(results) || results.length === 0) {
      return null;
    }

    const match = results[0];
    const latitude = Number(match.latitude);
    const longitude = Number(match.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw badGateway('Destination lookup response was malformed.');
    }

    return {
      name: typeof match.name === 'string' ? match.name : query,
      country: typeof match.country === 'string' ? match.country : null,
      countryCode:
        typeof match.country_code === 'string' && match.country_code.length === 2
          ? match.country_code.toUpperCase()
          : null,
      latitude,
      longitude,
      timezone: typeof match.timezone === 'string' ? match.timezone : null
    };
  }

  // Fetch a short daily outlook for one coordinate pair. Returns null when the
  // enricher is disabled, a normalized result on success, throws a 400-style
  // Error on bad input and a 502-style Error on any upstream problem.
  async function forecast(latitude, longitude, { days = 5 } = {}) {
    if (!active) return null;

    const lat = normalizeLatitude(latitude);
    const lon = normalizeLongitude(longitude);
    const forecastDays = normalizeDays(days);

    let payload;
    try {
      payload = await client(
        `${FORECAST_BASE_URL}?latitude=${lat}&longitude=${lon}&daily=${DAILY_FIELDS}&timezone=auto&forecast_days=${forecastDays}`,
        { timeoutMs, headers: { accept: 'application/json' } }
      );
    } catch (err) {
      throw badGateway('Weather is unavailable right now. Please try again later.', err);
    }

    if (!isPlainObject(payload) || !isPlainObject(payload.daily) || !Array.isArray(payload.daily.time)) {
      throw badGateway('Weather response was malformed.');
    }

    const daily = payload.daily;
    const dayList = daily.time.map((date, index) => {
      const weatherCode = numberAt(daily.weather_code, index);
      return {
        date,
        weatherCode,
        description: describeWeatherCode(weatherCode),
        tempMaxC: numberAt(daily.temperature_2m_max, index),
        tempMinC: numberAt(daily.temperature_2m_min, index),
        precipitationChance: numberAt(daily.precipitation_probability_max, index),
        windMaxKmh: numberAt(daily.wind_speed_10m_max, index)
      };
    });

    return {
      source: SOURCE_LABEL,
      latitude: lat,
      longitude: lon,
      timezone: typeof payload.timezone === 'string' ? payload.timezone : null,
      days: dayList,
      fetchedAt: new Date(now()).toISOString()
    };
  }

  return {
    enabled: active,
    geocode,
    forecast
  };
}
