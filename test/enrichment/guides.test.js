import test from 'node:test';
import assert from 'node:assert/strict';
import { createGuides } from '../../src/enrichment/guides.js';

// A realistic MediaWiki (formatversion=2) extracts payload for one page.
function samplePayload(page) {
  return {
    batchcomplete: true,
    query: {
      pages: [page]
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

function enabledGuides(result, overrides = {}) {
  return createGuides({ fetchJson: fakeFetchJson(result), enabled: true, ...overrides });
}

test('disabled when enabled is false: guide() returns null', async () => {
  const enricher = createGuides({ fetchJson: fakeFetchJson({}), enabled: false });
  assert.equal(enricher.enabled, false);
  assert.equal(await enricher.guide('Vienna'), null);
});

test('disabled when no fetchJson is provided even if enabled is true', async () => {
  const enricher = createGuides({ enabled: true });
  assert.equal(enricher.enabled, false);
  assert.equal(await enricher.guide('Vienna'), null);
});

test('defaults produce a disabled enricher', async () => {
  const enricher = createGuides();
  assert.equal(enricher.enabled, false);
  assert.equal(await enricher.guide('Vienna'), null);
});

test('rejects a non-string destination with a 400', async () => {
  const enricher = enabledGuides(samplePayload({}));
  await assert.rejects(() => enricher.guide(42), (err) => {
    assert.equal(err.statusCode, 400);
    assert.equal(err.message, 'destination must be a non-empty string of at most 120 characters');
    return true;
  });
});

test('rejects a destination that is empty after trimming with a 400', async () => {
  const enricher = enabledGuides(samplePayload({}));
  await assert.rejects(() => enricher.guide('   '), (err) => {
    assert.equal(err.statusCode, 400);
    assert.equal(err.message, 'destination must be a non-empty string of at most 120 characters');
    return true;
  });
});

test('rejects a destination longer than 120 characters with a 400', async () => {
  const enricher = enabledGuides(samplePayload({}));
  await assert.rejects(() => enricher.guide('x'.repeat(121)), (err) => {
    assert.equal(err.statusCode, 400);
    assert.equal(err.message, 'destination must be a non-empty string of at most 120 characters');
    return true;
  });
});

test('returns a normalized, attributed result on success', async () => {
  const fetchJson = fakeFetchJson(samplePayload({
    pageid: 37855,
    ns: 0,
    title: 'New York City',
    extract: 'New York City is the largest city in the United States.'
  }));
  const enricher = createGuides({
    fetchJson,
    enabled: true,
    timeoutMs: 1234,
    now: () => 1_700_000_000_000
  });
  assert.equal(enricher.enabled, true);

  const result = await enricher.guide('  New York City  ');

  assert.deepEqual(result, {
    source: 'Wikivoyage (enrichment only)',
    attribution: 'Guide text from Wikivoyage, CC BY-SA 4.0',
    title: 'New York City',
    summary: 'New York City is the largest city in the United States.',
    url: 'https://en.wikivoyage.org/wiki/New_York_City',
    fetchedAt: new Date(1_700_000_000_000).toISOString()
  });

  // The upstream call used the injected client with the right URL and options.
  assert.equal(fetchJson.calls.length, 1);
  assert.ok(fetchJson.calls[0].url.includes('titles=New%20York%20City'));
  assert.ok(fetchJson.calls[0].url.includes('formatversion=2'));
  assert.ok(fetchJson.calls[0].url.startsWith('https://en.wikivoyage.org/w/api.php?action=query&prop=extracts'));
  assert.equal(fetchJson.calls[0].options.timeoutMs, 1234);
  assert.deepEqual(fetchJson.calls[0].options.headers, { accept: 'application/json' });
});

test('accepts a destination of exactly 120 characters', async () => {
  const enricher = enabledGuides(samplePayload({ title: 'Somewhere', extract: 'A place.' }));
  const result = await enricher.guide('x'.repeat(120));
  assert.equal(result.title, 'Somewhere');
});

test('uses the default clock for fetchedAt when now is not injected', async () => {
  const before = Date.now();
  const enricher = enabledGuides(samplePayload({ title: 'Vienna', extract: 'Capital of Austria.' }));
  const result = await enricher.guide('Vienna');
  const stamp = Date.parse(result.fetchedAt);
  assert.ok(stamp >= before && stamp <= Date.now());
});

test('wraps an upstream failure into a safe 502 and does not leak detail', async () => {
  const leak = new Error('ECONNREFUSED 10.0.0.5:443 secret-internal-host');
  const fetchJson = async () => { throw leak; };
  const enricher = createGuides({ fetchJson, enabled: true });

  await assert.rejects(() => enricher.guide('Vienna'), (err) => {
    assert.equal(err.statusCode, 502);
    assert.doesNotMatch(err.message, /ECONNREFUSED|10\.0\.0\.5|secret-internal-host/);
    assert.equal(err.cause, leak); // detail preserved for logs, not for the client
    return true;
  });
});

// Every malformed upstream shape maps to the same safe 502.
for (const [label, payload] of [
  ['a null payload', null],
  ['a non-object payload', 'not-an-object'],
  ['a payload with a missing query', {}],
  ['a payload with a non-object query', { query: 'not-an-object' }],
  ['a payload whose query.pages is not an array', { query: { pages: { 0: {} } } }]
]) {
  test(`wraps ${label} into a 502`, async () => {
    const enricher = enabledGuides(payload);
    await assert.rejects(() => enricher.guide('Vienna'), (err) => {
      assert.equal(err.statusCode, 502);
      assert.equal(err.message, 'Destination guide response was malformed.');
      return true;
    });
  });
}

// A destination without a usable guide page is not an error: guide() maps
// every "no page" shape to null.
for (const [label, payload] of [
  ['an empty pages array', { query: { pages: [] } }],
  ['a null page entry', samplePayload(null)],
  ['a non-object page entry', samplePayload('not-an-object')],
  ['a missing page', samplePayload({ title: 'Nowhereville', missing: true })],
  ['a page without an extract', samplePayload({ title: 'Vienna' })],
  ['a page with a whitespace-only extract', samplePayload({ title: 'Vienna', extract: '   ' })]
]) {
  test(`returns null for ${label}`, async () => {
    const enricher = enabledGuides(payload);
    assert.equal(await enricher.guide('Vienna'), null);
  });
}

test('passes a short extract through unchanged, trimmed', async () => {
  const enricher = enabledGuides(samplePayload({
    title: 'Vienna',
    extract: '  Vienna is the capital of Austria.  '
  }));
  const result = await enricher.guide('Vienna');
  assert.equal(result.summary, 'Vienna is the capital of Austria.');
});

test('truncates a long extract at the last word boundary and appends an ellipsis', async () => {
  // 1190 chars, then a space, then a tail that pushes past the 1200 limit.
  // The cut lands on that space, so the tail never leaks into the summary.
  const extract = 'x'.repeat(1190) + ' ' + 'y'.repeat(50);
  const enricher = enabledGuides(samplePayload({ title: 'Vienna', extract }));
  const result = await enricher.guide('Vienna');
  assert.equal(result.summary, 'x'.repeat(1190) + '…');
});

test('hard-cuts a long extract with no spaces at 1200 characters', async () => {
  const extract = 'z'.repeat(1300);
  const enricher = enabledGuides(samplePayload({ title: 'Vienna', extract }));
  const result = await enricher.guide('Vienna');
  assert.equal(result.summary, 'z'.repeat(1200) + '…');
});

test('falls back to the trimmed input when the page has no title', async () => {
  const enricher = enabledGuides(samplePayload({ extract: 'A lovely place.' }));
  const result = await enricher.guide('  Rock Springs  ');
  assert.equal(result.title, 'Rock Springs');
  assert.equal(result.url, 'https://en.wikivoyage.org/wiki/Rock_Springs');
});

test('falls back to the trimmed input when the page title is empty', async () => {
  const enricher = enabledGuides(samplePayload({ title: '', extract: 'A lovely place.' }));
  const result = await enricher.guide('Vienna');
  assert.equal(result.title, 'Vienna');
  assert.equal(result.url, 'https://en.wikivoyage.org/wiki/Vienna');
});
