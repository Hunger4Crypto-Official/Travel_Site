import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicHolidays } from '../../src/enrichment/publicHolidays.js';

// A realistic Nager.Date v3 PublicHolidays payload. The second entry and the
// junk entries are shaped to exercise every normalization branch:
//   - entry 1: full record (localName string, name string, global true, types)
//   - entry 2: minimal record (no localName, no name, global false, no types)
//   - null / non-object / bad-date entries: filtered out
function samplePayload() {
  return [
    {
      date: '2024-01-01',
      localName: 'Neujahr',
      name: "New Year's Day",
      countryCode: 'AT',
      fixed: true,
      global: true,
      counties: null,
      launchYear: null,
      types: ['Public']
    },
    {
      date: '2024-05-01',
      global: false
    },
    null,
    'not-an-object',
    { date: 12345 }
  ];
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

test('disabled when enabled is false: holidays() returns null', async () => {
  const enricher = createPublicHolidays({ fetchJson: fakeFetchJson([]), enabled: false });
  assert.equal(enricher.enabled, false);
  assert.equal(await enricher.holidays('US', 2024), null);
});

test('disabled when no fetchJson is provided even if enabled is true', async () => {
  const enricher = createPublicHolidays({ enabled: true });
  assert.equal(enricher.enabled, false);
  assert.equal(await enricher.holidays('US', 2024), null);
});

test('defaults produce a disabled enricher', async () => {
  const enricher = createPublicHolidays();
  assert.equal(enricher.enabled, false);
  assert.equal(await enricher.holidays('US', 2024), null);
});

test('rejects a non-string country code with a 400', async () => {
  const enricher = createPublicHolidays({ fetchJson: fakeFetchJson([]), enabled: true });
  await assert.rejects(() => enricher.holidays(42, 2024), (err) => {
    assert.equal(err.statusCode, 400);
    assert.match(err.message, /countryCode must be a string/);
    return true;
  });
});

test('rejects a malformed country code with a 400', async () => {
  const enricher = createPublicHolidays({ fetchJson: fakeFetchJson([]), enabled: true });
  await assert.rejects(() => enricher.holidays('USA', 2024), (err) => {
    assert.equal(err.statusCode, 400);
    assert.match(err.message, /ISO 3166-1 alpha-2/);
    return true;
  });
});

test('rejects a non-integer year with a 400', async () => {
  const enricher = createPublicHolidays({ fetchJson: fakeFetchJson([]), enabled: true });
  await assert.rejects(() => enricher.holidays('US', 'not-a-year'), (err) => {
    assert.equal(err.statusCode, 400);
    assert.match(err.message, /year must be an integer/);
    return true;
  });
});

test('rejects a year below the supported range with a 400', async () => {
  const enricher = createPublicHolidays({ fetchJson: fakeFetchJson([]), enabled: true });
  await assert.rejects(() => enricher.holidays('US', 1000), (err) => {
    assert.equal(err.statusCode, 400);
    return true;
  });
});

test('rejects a year above the supported range with a 400', async () => {
  const enricher = createPublicHolidays({ fetchJson: fakeFetchJson([]), enabled: true });
  await assert.rejects(() => enricher.holidays('US', 3000), (err) => {
    assert.equal(err.statusCode, 400);
    return true;
  });
});

test('returns a normalized, clearly labeled result on success', async () => {
  const fetchJson = fakeFetchJson(samplePayload());
  const enricher = createPublicHolidays({
    fetchJson,
    enabled: true,
    timeoutMs: 1234,
    now: () => 1_700_000_000_000
  });
  assert.equal(enricher.enabled, true);

  const result = await enricher.holidays('  at  ', 2024);

  // Country code is trimmed and upper-cased, year echoed back.
  assert.equal(result.source, 'Nager.Date public holidays (enrichment only)');
  assert.equal(result.countryCode, 'AT');
  assert.equal(result.year, 2024);
  assert.equal(result.fetchedAt, new Date(1_700_000_000_000).toISOString());

  // Only the two well-formed entries survive normalization.
  assert.equal(result.count, 2);
  assert.equal(result.holidays.length, 2);

  assert.deepEqual(result.holidays[0], {
    date: '2024-01-01',
    localName: 'Neujahr',
    name: "New Year's Day",
    nationwide: true,
    types: ['Public']
  });

  // Minimal record: missing fields fall back safely.
  assert.deepEqual(result.holidays[1], {
    date: '2024-05-01',
    localName: null,
    name: '2024-05-01',
    nationwide: false,
    types: []
  });

  // The upstream call used the injected client with the right URL and options.
  assert.equal(fetchJson.calls.length, 1);
  assert.equal(fetchJson.calls[0].url, 'https://date.nager.at/api/v3/PublicHolidays/2024/AT');
  assert.equal(fetchJson.calls[0].options.timeoutMs, 1234);
  assert.deepEqual(fetchJson.calls[0].options.headers, { accept: 'application/json' });
});

test('uses the default clock for fetchedAt when now is not injected', async () => {
  const before = Date.now();
  const enricher = createPublicHolidays({ fetchJson: fakeFetchJson([]), enabled: true });
  const result = await enricher.holidays('US', 2024);
  const stamp = Date.parse(result.fetchedAt);
  assert.ok(stamp >= before && stamp <= Date.now());
  assert.equal(result.count, 0);
});

test('wraps an upstream failure into a safe 502 and does not leak detail', async () => {
  const leak = new Error('ECONNREFUSED 10.0.0.5:443 secret-internal-host');
  const fetchJson = async () => { throw leak; };
  const enricher = createPublicHolidays({ fetchJson, enabled: true });

  await assert.rejects(() => enricher.holidays('FR', 2025), (err) => {
    assert.equal(err.statusCode, 502);
    assert.doesNotMatch(err.message, /ECONNREFUSED|10\.0\.0\.5|secret-internal-host/);
    assert.equal(err.cause, leak); // detail preserved for logs, not for the client
    return true;
  });
});

test('wraps a malformed (non-array) upstream response into a 502', async () => {
  const fetchJson = fakeFetchJson({ not: 'an array' });
  const enricher = createPublicHolidays({ fetchJson, enabled: true });

  await assert.rejects(() => enricher.holidays('DE', 2024), (err) => {
    assert.equal(err.statusCode, 502);
    assert.match(err.message, /malformed/);
    return true;
  });
});
