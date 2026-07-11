// Nearby-places enrichment backed by OpenStreetMap's Overpass API.
//
//   API:      Overpass API (OpenStreetMap query engine)
//   Base URL: https://overpass-api.de/api/interpreter
//   Access:   FREE and KEYLESS (no registration, no API key, no auth header).
//
// ATTRIBUTION: OpenStreetMap data is licensed under the Open Database License
// (ODbL 1.0). Any surface that displays these results MUST credit
// "(c) OpenStreetMap contributors" and the `attribution` field returned by
// this module carries that credit for callers to pass through.
//
// ENRICHMENT ONLY. This module provides travel context (named points of
// interest near a coordinate) and MUST NEVER be used for pricing, ranking,
// booking, money movement, or compliance decisions. It only reads and returns
// a small, clearly labeled slice of map facts.
//
// Contract:
//   - When `enabled` is false OR no `fetchJson` is provided, every call returns
//     null (a disabled marker). Callers treat null as "no enrichment available"
//     and carry on without inventing data.
//   - Bad input throws an Error with `.statusCode = 400`.
//   - Any upstream failure or malformed response is wrapped into an Error with
//     `.statusCode = 502` and a safe, generic message. Upstream error detail is
//     kept only on `.cause` and never placed in the client-facing message.

const BASE_URL = 'https://overpass-api.de/api/interpreter';
const SOURCE_LABEL = 'OpenStreetMap via Overpass (enrichment only)';
const ATTRIBUTION = 'Map data (c) OpenStreetMap contributors (ODbL 1.0)';
const MIN_RADIUS_M = 100;
const MAX_RADIUS_M = 5000;
const MIN_LIMIT = 1;
const MAX_LIMIT = 30;

// Category key -> Overpass tag selectors. Frozen because other modules key
// their own configuration off these exact names.
export const CATEGORIES = Object.freeze({
  eat: ['node["amenity"="restaurant"]'],
  cafe: ['node["amenity"="cafe"]'],
  drink: ['node["amenity"="bar"]', 'node["amenity"="pub"]'],
  see: [
    'node["tourism"="attraction"]',
    'node["tourism"="museum"]',
    'node["tourism"="viewpoint"]',
    'node["tourism"="artwork"]'
  ],
  park: ['node["leisure"="park"]', 'way["leisure"="park"]']
});

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

function normalizeCategory(raw) {
  if (!Object.hasOwn(CATEGORIES, raw)) {
    throw badRequest(`category must be one of: ${Object.keys(CATEGORIES).join(', ')}`);
  }
  return raw;
}

function normalizeRadius(raw) {
  if (!Number.isInteger(raw) || raw < MIN_RADIUS_M || raw > MAX_RADIUS_M) {
    throw badRequest(`radiusM must be an integer between ${MIN_RADIUS_M} and ${MAX_RADIUS_M}`);
  }
  return raw;
}

function normalizeLimit(raw) {
  if (!Number.isInteger(raw) || raw < MIN_LIMIT || raw > MAX_LIMIT) {
    throw badRequest(`limit must be an integer between ${MIN_LIMIT} and ${MAX_LIMIT}`);
  }
  return raw;
}

// Pull the display coordinate off one Overpass element. Nodes carry lat/lon
// directly; ways and relations carry a computed `center` (from `out center`).
function elementCoordinates(element) {
  if (element.type === 'node') {
    return { latitude: element.lat, longitude: element.lon };
  }
  if (element.center && typeof element.center === 'object') {
    return { latitude: element.center.lat, longitude: element.center.lon };
  }
  return { latitude: NaN, longitude: NaN };
}

// Reduce one upstream Overpass element to a small, clearly labeled place.
// Returns null for anything unusable (no name, no coordinate, junk shape) so
// the caller can filter it out rather than surface junk.
function normalizePlace(element, category) {
  if (!element || typeof element !== 'object') return null;

  const tags = element.tags && typeof element.tags === 'object' ? element.tags : {};
  if (typeof tags.name !== 'string') return null; // unnamed places are noise

  const { latitude, longitude } = elementCoordinates(element);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  let kind = null;
  if (typeof tags.amenity === 'string') kind = tags.amenity;
  else if (typeof tags.tourism === 'string') kind = tags.tourism;
  else if (typeof tags.leisure === 'string') kind = tags.leisure;

  return {
    id: `${element.type}/${element.id}`,
    name: tags.name,
    category,
    kind,
    latitude,
    longitude,
    website: typeof tags.website === 'string' ? tags.website : null,
    openingHours: typeof tags.opening_hours === 'string' ? tags.opening_hours : null,
    mapUrl: `https://www.openstreetmap.org/${element.type}/${element.id}`
  };
}

// Factory. `fetchJson` is injected so tests never touch the network; it must
// share the signature of src/utils/httpClient.js#fetchJson.
export function createPlaces({
  fetchJson = null,
  enabled = false,
  timeoutMs = 8000,
  now = () => Date.now()
} = {}) {
  const client = typeof fetchJson === 'function' ? fetchJson : null;
  const active = enabled === true && client !== null;

  // Fetch and normalize named places around one coordinate. Returns null when
  // the enricher is disabled, a normalized result on success, throws a
  // 400-style Error on bad input and a 502-style Error on any upstream
  // problem.
  async function nearby(latitude, longitude, { category = 'see', radiusM = 1500, limit = 12 } = {}) {
    if (!active) return null;

    const lat = normalizeLatitude(latitude);
    const lon = normalizeLongitude(longitude);
    const resolvedCategory = normalizeCategory(category);
    const radius = normalizeRadius(radiusM);
    const resolvedLimit = normalizeLimit(limit);

    // Overpass QL: one around-filter per selector, union of all matches.
    // We over-fetch (limit * 2) because unnamed elements and duplicate names
    // are dropped during normalization.
    let query = '[out:json][timeout:8];(';
    for (const selector of CATEGORIES[resolvedCategory]) {
      query += `${selector}(around:${radius},${lat},${lon});`;
    }
    query += ');out center ' + resolvedLimit * 2 + ';';

    let payload;
    try {
      // Overpass supports GET with the query in the `data` parameter.
      payload = await client(`${BASE_URL}?data=${encodeURIComponent(query)}`, {
        timeoutMs,
        headers: { accept: 'application/json' }
      });
    } catch (err) {
      throw badGateway('Nearby places are unavailable right now. Please try again later.', err);
    }

    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.elements)) {
      throw badGateway('Nearby places response was malformed.');
    }

    const places = [];
    const seenNames = new Set();
    for (const element of payload.elements) {
      if (places.length >= resolvedLimit) break;
      const place = normalizePlace(element, resolvedCategory);
      if (!place) continue;
      const nameKey = place.name.toLowerCase();
      if (seenNames.has(nameKey)) continue; // first occurrence wins
      seenNames.add(nameKey);
      places.push(place);
    }

    return {
      source: SOURCE_LABEL,
      attribution: ATTRIBUTION,
      category: resolvedCategory,
      radiusM: radius,
      count: places.length,
      places,
      fetchedAt: new Date(now()).toISOString()
    };
  }

  return {
    enabled: active,
    nearby
  };
}
