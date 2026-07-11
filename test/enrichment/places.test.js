import test from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORIES, createPlaces } from '../../src/enrichment/places.js';

// A realistic Overpass API payload. The elements are shaped to exercise every
// normalization branch:
//   - node with tourism tags, website and opening_hours: full record
//   - way with a computed center and a leisure tag
//   - node with an amenity tag but no website / opening_hours
//   - node with a name but none of amenity / tourism / leisure (kind null)
//   - null / non-object / junk-tags / unnamed / uncentered / bad-coordinate
//     elements and a duplicate name: all filtered out
function samplePayload() {
  return {
    version: 0.6,
    generator: 'Overpass API',
    elements: [
      {
        type: 'node',
        id: 101,
        lat: 48.2,
        lon: 16.37,
        tags: {
          name: 'Stephansdom',
          tourism: 'attraction',
          website: 'https://example.test/stephansdom',
          opening_hours: 'Mo-Su 06:00-22:00'
        }
      },
      {
        type: 'way',
        id: 202,
        center: { lat: 48.21, lon: 16.36 },
        tags: { name: 'Stadtpark', leisure: 'park' }
      },
      {
        type: 'node',
        id: 303,
        lat: 48.19,
        lon: 16.35,
        tags: { name: 'Cafe Central', amenity: 'cafe' }
      },
      {
        type: 'node',
        id: 404,
        lat: 48.18,
        lon: 16.34,
        tags: { name: 'Mystery Spot' }
      },
      null, // not an object
      'not-an-object',
      { type: 'node', id: 500, lat: 48.1, lon: 16.3 }, // no tags at all
      { type: 'node', id: 501, lat: 48.1, lon: 16.3, tags: 'junk' }, // tags not an object
      { type: 'node', id: 502, lat: 48.1, lon: 16.3, tags: { tourism: 'museum' } }, // unnamed
      { type: 'way', id: 503, tags: { name: 'No Center Way' } }, // way missing center
      { type: 'way', id: 504, center: 'oops', tags: { name: 'Bad Center Way' } },
      { type: 'node', id: 505, lat: 'north', lon: 16.3, tags: { name: 'Bad Lat' } },
      { type: 'node', id: 506, lat: 48.1, lon: 'east', tags: { name: 'Bad Lon' } },
      // Duplicate of the first place, different casing: first occurrence wins.
      { type: 'node', id: 507, lat: 48.3, lon: 16.4, tags: { name: 'STEPHANSDOM' } }
    ]
  };
}

// A fake fetchJson matching src/utils/httpClient.js#fetchJson. It records
// calls and never touches the network.
function fakeFetchJson(result) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, options });
    return typeof result === 'function' ? result(url, options) : result;
  };
  fn.calls = calls;
  return fn;
}

function activePlaces(overrides = {}) {
  return createPlaces({
    fetchJson: fakeFetchJson({ elements: [] }),
    enabled: true,
    ...overrides
  });
}

test('CATEGORIES is a frozen map of the supported category selectors', () => {
  assert.ok(Object.isFrozen(CATEGORIES));
  assert.deepEqual(Object.keys(CATEGORIES), ['eat', 'cafe', 'drink', 'see', 'park']);
  assert.deepEqual(CATEGORIES.eat, ['node["amenity"="restaurant"]']);
  assert.deepEqual(CATEGORIES.cafe, ['node["amenity"="cafe"]']);
  assert.deepEqual(CATEGORIES.drink, ['node["amenity"="bar"]', 'node["amenity"="pub"]']);
  assert.deepEqual(CATEGORIES.see, [
    'node["tourism"="attraction"]',
    'node["tourism"="museum"]',
    'node["tourism"="viewpoint"]',
    'node["tourism"="artwork"]'
  ]);
  assert.deepEqual(CATEGORIES.park, ['node["leisure"="park"]', 'way["leisure"="park"]']);
});

test('disabled when enabled is false: nearby() returns null', async () => {
  const enricher = createPlaces({ fetchJson: fakeFetchJson({ elements: [] }), enabled: false });
  assert.equal(enricher.enabled, false);
  assert.equal(await enricher.nearby(48.2, 16.37), null);
});

test('disabled when no fetchJson is provided even if enabled is true', async () => {
  const enricher = createPlaces({ enabled: true });
  assert.equal(enricher.enabled, false);
  assert.equal(await enricher.nearby(48.2, 16.37), null);
});

test('defaults produce a disabled enricher', async () => {
  const enricher = createPlaces();
  assert.equal(enricher.enabled, false);
  assert.equal(await enricher.nearby(48.2, 16.37), null);
});

test('rejects a non-finite latitude with a 400', async () => {
  const enricher = activePlaces();
  await assert.rejects(() => enricher.nearby(Number.NaN, 16.37), (err) => {
    assert.equal(err.statusCode, 400);
    assert.match(err.message, /latitude must be a finite number/);
    return true;
  });
});

test('rejects a latitude below -90 with a 400', async () => {
  const enricher = activePlaces();
  await assert.rejects(() => enricher.nearby(-90.5, 16.37), (err) => {
    assert.equal(err.statusCode, 400);
    return true;
  });
});

test('rejects a latitude above 90 with a 400', async () => {
  const enricher = activePlaces();
  await assert.rejects(() => enricher.nearby(90.5, 16.37), (err) => {
    assert.equal(err.statusCode, 400);
    return true;
  });
});

test('rejects a non-finite longitude with a 400', async () => {
  const enricher = activePlaces();
  await assert.rejects(() => enricher.nearby(48.2, Number.POSITIVE_INFINITY), (err) => {
    assert.equal(err.statusCode, 400);
    assert.match(err.message, /longitude must be a finite number/);
    return true;
  });
});

test('rejects a longitude below -180 with a 400', async () => {
  const enricher = activePlaces();
  await assert.rejects(() => enricher.nearby(48.2, -180.5), (err) => {
    assert.equal(err.statusCode, 400);
    return true;
  });
});

test('rejects a longitude above 180 with a 400', async () => {
  const enricher = activePlaces();
  await assert.rejects(() => enricher.nearby(48.2, 180.5), (err) => {
    assert.equal(err.statusCode, 400);
    return true;
  });
});

test('rejects an unknown category with a 400 that lists the valid keys', async () => {
  const enricher = activePlaces();
  await assert.rejects(() => enricher.nearby(48.2, 16.37, { category: 'toString' }), (err) => {
    assert.equal(err.statusCode, 400);
    assert.match(err.message, /category must be one of: eat, cafe, drink, see, park/);
    return true;
  });
});

test('rejects a non-integer radiusM with a 400', async () => {
  const enricher = activePlaces();
  await assert.rejects(() => enricher.nearby(48.2, 16.37, { radiusM: 1500.5 }), (err) => {
    assert.equal(err.statusCode, 400);
    assert.match(err.message, /radiusM must be an integer between 100 and 5000/);
    return true;
  });
});

test('rejects a radiusM below 100 with a 400', async () => {
  const enricher = activePlaces();
  await assert.rejects(() => enricher.nearby(48.2, 16.37, { radiusM: 99 }), (err) => {
    assert.equal(err.statusCode, 400);
    return true;
  });
});

test('rejects a radiusM above 5000 with a 400', async () => {
  const enricher = activePlaces();
  await assert.rejects(() => enricher.nearby(48.2, 16.37, { radiusM: 5001 }), (err) => {
    assert.equal(err.statusCode, 400);
    return true;
  });
});

test('rejects a non-integer limit with a 400', async () => {
  const enricher = activePlaces();
  await assert.rejects(() => enricher.nearby(48.2, 16.37, { limit: 'twelve' }), (err) => {
    assert.equal(err.statusCode, 400);
    assert.match(err.message, /limit must be an integer between 1 and 30/);
    return true;
  });
});

test('rejects a limit below 1 with a 400', async () => {
  const enricher = activePlaces();
  await assert.rejects(() => enricher.nearby(48.2, 16.37, { limit: 0 }), (err) => {
    assert.equal(err.statusCode, 400);
    return true;
  });
});

test('rejects a limit above 30 with a 400', async () => {
  const enricher = activePlaces();
  await assert.rejects(() => enricher.nearby(48.2, 16.37, { limit: 31 }), (err) => {
    assert.equal(err.statusCode, 400);
    return true;
  });
});

test('returns normalized, deduplicated places and labels the result clearly', async () => {
  const fetchJson = fakeFetchJson(samplePayload());
  const enricher = createPlaces({
    fetchJson,
    enabled: true,
    timeoutMs: 1234,
    now: () => 1_700_000_000_000
  });
  assert.equal(enricher.enabled, true);

  const result = await enricher.nearby(48.2, 16.37, { category: 'see', radiusM: 900, limit: 10 });

  assert.equal(result.source, 'OpenStreetMap via Overpass (enrichment only)');
  assert.equal(result.attribution, 'Map data (c) OpenStreetMap contributors (ODbL 1.0)');
  assert.equal(result.category, 'see');
  assert.equal(result.radiusM, 900);
  assert.equal(result.fetchedAt, new Date(1_700_000_000_000).toISOString());

  // Only the four usable elements survive: junk shapes, unnamed elements,
  // missing / malformed coordinates and the duplicate name are filtered out.
  assert.equal(result.count, 4);
  assert.equal(result.places.length, 4);

  // Node coordinates come from lat/lon; kind falls through to tourism when
  // amenity is absent; website and opening_hours pass through as strings.
  assert.deepEqual(result.places[0], {
    id: 'node/101',
    name: 'Stephansdom',
    category: 'see',
    kind: 'attraction',
    latitude: 48.2,
    longitude: 16.37,
    website: 'https://example.test/stephansdom',
    openingHours: 'Mo-Su 06:00-22:00',
    mapUrl: 'https://www.openstreetmap.org/node/101'
  });

  // Way coordinates come from the computed center; kind falls through to
  // leisure when amenity and tourism are absent.
  assert.deepEqual(result.places[1], {
    id: 'way/202',
    name: 'Stadtpark',
    category: 'see',
    kind: 'park',
    latitude: 48.21,
    longitude: 16.36,
    website: null,
    openingHours: null,
    mapUrl: 'https://www.openstreetmap.org/way/202'
  });

  // amenity wins the kind resolution; missing website / opening_hours are null.
  assert.equal(result.places[2].id, 'node/303');
  assert.equal(result.places[2].kind, 'cafe');
  assert.equal(result.places[2].website, null);
  assert.equal(result.places[2].openingHours, null);

  // No amenity / tourism / leisure tag at all: kind is null.
  assert.equal(result.places[3].id, 'node/404');
  assert.equal(result.places[3].kind, null);

  // The duplicate name never made it in, even with different casing.
  assert.ok(!result.places.some((place) => place.id === 'node/507'));

  // The upstream call used the injected client with a GET-style Overpass URL:
  // every selector for the category, the around filter and an over-fetching
  // out clause of limit * 2.
  assert.equal(fetchJson.calls.length, 1);
  const expectedQuery = '[out:json][timeout:8];(' +
    CATEGORIES.see.map((selector) => `${selector}(around:900,48.2,16.37);`).join('') +
    ');out center 20;';
  assert.equal(
    fetchJson.calls[0].url,
    `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(expectedQuery)}`
  );
  assert.ok(fetchJson.calls[0].url.includes(encodeURIComponent('around:900,48.2,16.37')));
  assert.ok(fetchJson.calls[0].url.includes(encodeURIComponent('out center 20')));
  assert.equal(fetchJson.calls[0].options.timeoutMs, 1234);
  assert.deepEqual(fetchJson.calls[0].options.headers, { accept: 'application/json' });
});

test('applies the documented defaults when no options are passed', async () => {
  const fetchJson = fakeFetchJson({ elements: [] });
  const enricher = createPlaces({ fetchJson, enabled: true });

  const result = await enricher.nearby(10, 20);

  assert.equal(result.category, 'see');
  assert.equal(result.radiusM, 1500);
  assert.equal(result.count, 0);
  assert.deepEqual(result.places, []);

  // Default radius, default limit (12 -> out center 24) and default timeout.
  const decoded = decodeURIComponent(fetchJson.calls[0].url.split('?data=')[1]);
  assert.ok(decoded.includes('(around:1500,10,20);'));
  assert.ok(decoded.endsWith(');out center 24;'));
  assert.equal(fetchJson.calls[0].options.timeoutMs, 8000);
});

test('queries every selector for a multi-selector category', async () => {
  const fetchJson = fakeFetchJson({ elements: [] });
  const enricher = createPlaces({ fetchJson, enabled: true });

  await enricher.nearby(51.5, -0.12, { category: 'drink', radiusM: 250, limit: 5 });

  const decoded = decodeURIComponent(fetchJson.calls[0].url.split('?data=')[1]);
  assert.ok(decoded.includes('node["amenity"="bar"](around:250,51.5,-0.12);'));
  assert.ok(decoded.includes('node["amenity"="pub"](around:250,51.5,-0.12);'));
  assert.ok(decoded.includes(');out center 10;'));
});

test('stops collecting once the limit is reached', async () => {
  const elements = [1, 2, 3].map((id) => ({
    type: 'node',
    id,
    lat: 48 + id,
    lon: 16 + id,
    tags: { name: `Place ${id}` }
  }));
  const enricher = createPlaces({ fetchJson: fakeFetchJson({ elements }), enabled: true });

  const result = await enricher.nearby(48.2, 16.37, { limit: 2 });

  assert.equal(result.count, 2);
  assert.deepEqual(result.places.map((place) => place.name), ['Place 1', 'Place 2']);
});

test('uses the default clock for fetchedAt when now is not injected', async () => {
  const before = Date.now();
  const enricher = createPlaces({ fetchJson: fakeFetchJson({ elements: [] }), enabled: true });
  const result = await enricher.nearby(48.2, 16.37);
  const stamp = Date.parse(result.fetchedAt);
  assert.ok(stamp >= before && stamp <= Date.now());
  assert.equal(result.count, 0);
});

test('wraps an upstream failure into a safe 502 and does not leak detail', async () => {
  const leak = new Error('ECONNREFUSED 10.0.0.5:443 secret-internal-host');
  const fetchJson = async () => { throw leak; };
  const enricher = createPlaces({ fetchJson, enabled: true });

  await assert.rejects(() => enricher.nearby(48.2, 16.37), (err) => {
    assert.equal(err.statusCode, 502);
    assert.equal(err.message, 'Nearby places are unavailable right now. Please try again later.');
    assert.doesNotMatch(err.message, /ECONNREFUSED|10\.0\.0\.5|secret-internal-host/);
    assert.equal(err.cause, leak); // detail preserved for logs, not for the client
    return true;
  });
});

test('wraps a non-object upstream response into a 502', async () => {
  const enricher = createPlaces({ fetchJson: fakeFetchJson('not an object'), enabled: true });

  await assert.rejects(() => enricher.nearby(48.2, 16.37), (err) => {
    assert.equal(err.statusCode, 502);
    assert.match(err.message, /malformed/);
    return true;
  });
});

test('wraps a null upstream response into a 502', async () => {
  const enricher = createPlaces({ fetchJson: fakeFetchJson(null), enabled: true });

  await assert.rejects(() => enricher.nearby(48.2, 16.37), (err) => {
    assert.equal(err.statusCode, 502);
    assert.match(err.message, /malformed/);
    return true;
  });
});

test('wraps a response without an elements array into a 502', async () => {
  const enricher = createPlaces({ fetchJson: fakeFetchJson({ elements: 'nope' }), enabled: true });

  await assert.rejects(() => enricher.nearby(48.2, 16.37), (err) => {
    assert.equal(err.statusCode, 502);
    assert.match(err.message, /malformed/);
    return true;
  });
});
