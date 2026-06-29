const requiredFields = {
  flights: ['from', 'to'],
  hotels: ['city'],
  cars: ['city'],
  airports: ['code'],
  tracking: ['icao24']
};

const knownFields = new Set([
  'from', 'to', 'date', 'returnDate', 'adults', 'children', 'cabin',
  'city', 'cityCode', 'checkin', 'checkout', 'rooms',
  'code', 'icao24', 'sort', 'limit'
]);

const cityCodeFields = new Set(['cityCode']);
const integerFields = new Set(['adults', 'children', 'rooms', 'limit']);

const dateFields = new Set(['date', 'returnDate', 'checkin', 'checkout']);

export function validateQuery(type, query = {}, { maxQueryLength = 120, maxParams = 24 } = {}) {
  const normalized = normalizeQuery(query);

  const entries = Object.entries(normalized);
  if (entries.length > maxParams) {
    throwBadRequest(`Too many query parameters (max ${maxParams})`, { type, maxParams });
  }

  const missing = (requiredFields[type] || []).filter((field) => !normalized[field]);
  if (missing.length > 0) {
    throwBadRequest(`Missing required query parameter${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`, { type, missing });
  }

  for (const [key, value] of entries) {
    // Length-cap every parameter (known or not) so unknown fields cannot bloat
    // the request, the cache key, or downstream serialization.
    if (String(value).length > maxQueryLength) {
      throwBadRequest(`Query parameter is too long: ${key}`, { type, field: key, maxQueryLength });
    }
    if (!knownFields.has(key)) continue;
    if (dateFields.has(key) && !isIsoDate(value)) {
      throwBadRequest(`Invalid date format for ${key}. Expected YYYY-MM-DD`, { type, field: key });
    }
    if (cityCodeFields.has(key) && !/^[A-Za-z]{3}$/.test(String(value))) {
      throwBadRequest(`Invalid ${key}. Expected a 3-letter city/location code`, { type, field: key });
    }
    if (integerFields.has(key) && !/^\d+$/.test(String(value))) {
      throwBadRequest(`Invalid ${key}. Expected a non-negative integer`, { type, field: key });
    }
  }

  if (normalized.sort && !['price', 'score'].includes(normalized.sort)) {
    throwBadRequest('Invalid sort. Expected one of: price, score', { type, field: 'sort', allowed: ['price', 'score'] });
  }

  if (type === 'flights') {
    validateAirportCode('from', normalized.from, type);
    validateAirportCode('to', normalized.to, type);
    if (normalized.from === normalized.to) throwBadRequest('Flight origin and destination must be different', { type, fields: ['from', 'to'] });
  }

  if (type === 'airports') validateAirportCode('code', normalized.code, type);
  if (type === 'tracking' && !/^[a-f0-9]{6}$/i.test(normalized.icao24)) {
    throwBadRequest('Invalid icao24. Expected 6 hexadecimal characters', { type, field: 'icao24' });
  }

  if (normalized.checkin && normalized.checkout && normalized.checkout <= normalized.checkin) {
    throwBadRequest('checkout must be after checkin', { type, fields: ['checkin', 'checkout'] });
  }

  return normalized;
}

export function stableCacheKey(type, query = {}) {
  const sortedQuery = Object.fromEntries(Object.entries(normalizeQuery(query)).sort(([a], [b]) => a.localeCompare(b)));
  return JSON.stringify({ type, query: sortedQuery });
}

function normalizeQuery(query) {
  return Object.fromEntries(Object.entries(query).map(([key, value]) => [key, typeof value === 'string' ? value.trim() : value]));
}

function validateAirportCode(field, value, type) {
  if (!/^[A-Z]{3,4}$/.test(String(value).toUpperCase())) {
    throwBadRequest(`Invalid airport code for ${field}. Expected 3-4 letters`, { type, field });
  }
}

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function throwBadRequest(message, details) {
  const err = new Error(message);
  err.statusCode = 400;
  err.details = details;
  throw err;
}
