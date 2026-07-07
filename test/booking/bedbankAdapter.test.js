import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { createBedbankAdapter } from '../../src/booking/bedbankAdapter.js';

// --- fixtures ---------------------------------------------------------------

const OFFER = {
  type: 'hotels',
  provider: 'bedbank',
  id: 'HB-123',
  title: 'Grand Hotel',
  price: { total: 250, base: 200, taxes: 40, fees: 10, currency: 'EUR', estimated: false },
  details: { rateKey: 'RATE-KEY-XYZ' }
};

const LEAD = { givenName: 'Ada', familyName: 'Lovelace' };
const CONTACT = { email: 'ada@example.com' };

const FIXED_NOW = () => 1_700_000_000_000; // -> 1_700_000_000 unix seconds

function expectedSignature(apiKey, secret, nowMs) {
  const stamp = Math.floor(nowMs() / 1000);
  return createHash('sha256').update(apiKey + secret + stamp).digest('hex');
}

// A fake fetchJson that records calls and returns a scripted response.
function makeFetch(response) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, options });
    return response;
  };
  fn.calls = calls;
  return fn;
}

function makeRejectingFetch(error) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, options });
    throw error;
  };
  fn.calls = calls;
  return fn;
}

// --- adapter identity -------------------------------------------------------

test('sandbox adapter identity and live=false', () => {
  const adapter = createBedbankAdapter();
  assert.equal(adapter.name, 'bedbank');
  assert.equal(adapter.supports, 'hotels');
  assert.equal(adapter.live, false);
});

test('live=true only when both apiKey and secret present', () => {
  assert.equal(createBedbankAdapter({ apiKey: 'k', secret: 's' }).live, true);
  assert.equal(createBedbankAdapter({ apiKey: 'k' }).live, false);
  assert.equal(createBedbankAdapter({ secret: 's' }).live, false);
});

// --- sandbox book -----------------------------------------------------------

test('sandbox book is deterministic and stable', async () => {
  const adapter = createBedbankAdapter();
  const a = await adapter.book({ offer: OFFER, passengers: [LEAD], contact: CONTACT });
  const b = await adapter.book({ offer: OFFER, passengers: [LEAD], contact: CONTACT });

  const expectedConfirmation = createHash('sha1')
    .update(OFFER.id).digest('hex').slice(0, 8).toUpperCase();

  assert.deepEqual(a, {
    providerRef: 'hotelbeds_sandbox_HB-123',
    confirmation: expectedConfirmation,
    status: 'confirmed',
    bookedPrice: { total: 250, currency: 'EUR' },
    live: false
  });
  assert.deepEqual(a, b);
  assert.equal(a.confirmation.length, 8);
});

// --- sandbox cancel ---------------------------------------------------------

test('sandbox cancel returns null refund and makes no call', async () => {
  const adapter = createBedbankAdapter();
  const result = await adapter.cancel({ providerRef: 'hotelbeds_sandbox_HB-123' });
  assert.deepEqual(result, {
    status: 'cancelled',
    refund: { amount: null, currency: null },
    live: false
  });
});

// --- book validation errors -------------------------------------------------

test('book rejects invalid offers with 400', async () => {
  const adapter = createBedbankAdapter();
  const badOffers = [
    undefined,      // no args -> offer undefined
    null,
    'not-an-object',
    { id: 5, price: {} },          // id not a string
    { id: 'x' },                   // no price
    { id: 'x', price: 42 }         // price not an object
  ];
  for (const offer of badOffers) {
    const args = offer === undefined ? undefined : { offer, passengers: [LEAD], contact: CONTACT };
    await assert.rejects(
      () => (args ? adapter.book(args) : adapter.book()),
      (err) => {
        assert.equal(err.statusCode, 400);
        assert.equal(err.message, 'A valid hotel offer is required to book');
        assert.ok(!err.message.includes('—'));
        return true;
      }
    );
  }
});

test('book rejects invalid lead guest with 400', async () => {
  const adapter = createBedbankAdapter();
  const badPassengerSets = [
    undefined,                                  // not an array
    [],                                         // empty -> lead undefined
    [{ familyName: 'X' }],                      // givenName missing
    [{ givenName: '   ', familyName: 'X' }],    // givenName blank
    [{ givenName: 'A' }],                       // familyName missing
    [{ givenName: 'A', familyName: '  ' }]      // familyName blank
  ];
  for (const passengers of badPassengerSets) {
    await assert.rejects(
      () => adapter.book({ offer: OFFER, passengers, contact: CONTACT }),
      (err) => {
        assert.equal(err.statusCode, 400);
        assert.equal(err.message, 'A lead guest with a given and family name is required');
        return true;
      }
    );
  }
});

test('book rejects missing/invalid contact email with 400', async () => {
  const adapter = createBedbankAdapter();
  const badContacts = [null, {}, { email: 'not-an-email' }];
  for (const contact of badContacts) {
    await assert.rejects(
      () => adapter.book({ offer: OFFER, passengers: [LEAD], contact }),
      (err) => {
        assert.equal(err.statusCode, 400);
        assert.equal(err.message, 'A contact email is required to book');
        return true;
      }
    );
  }
});

// --- live book --------------------------------------------------------------

test('live book posts signed request and reads booking reference/price', async () => {
  const fetchJson = makeFetch({
    booking: { reference: 'BK-987', totalNet: 240.5, currency: 'USD' }
  });
  const adapter = createBedbankAdapter({
    apiKey: 'my-key', secret: 'my-secret', env: 'test', fetchJson, now: FIXED_NOW
  });

  const result = await adapter.book({ offer: OFFER, passengers: [LEAD], contact: CONTACT });

  assert.deepEqual(result, {
    providerRef: 'BK-987',
    confirmation: 'BK-987',
    status: 'confirmed',
    bookedPrice: { total: 240.5, currency: 'USD' },
    live: true
  });

  assert.equal(fetchJson.calls.length, 1);
  const { url, options } = fetchJson.calls[0];
  assert.equal(url, 'https://api.test.hotelbeds.com/hotel-api/1.0/bookings');
  assert.equal(options.method, 'POST');
  assert.equal(options.headers['Api-key'], 'my-key');
  assert.equal(options.headers['Content-Type'], 'application/json');
  assert.equal(options.headers.Accept, 'application/json');

  const sig = options.headers['X-Signature'];
  assert.equal(typeof sig, 'string');
  assert.ok(sig.length > 0);
  assert.equal(sig, expectedSignature('my-key', 'my-secret', FIXED_NOW));

  const body = JSON.parse(options.body);
  assert.deepEqual(body.holder, { name: 'Ada', surname: 'Lovelace' });
  assert.equal(body.rooms[0].rateKey, 'RATE-KEY-XYZ');
  assert.deepEqual(body.rooms[0].paxes[0], { roomId: 1, type: 'AD', name: 'Ada', surname: 'Lovelace' });
  assert.equal(body.clientReference, 'THE-TRAVEL-CLUB');
});

test('live book falls back to offer id rateKey and offer price when response is sparse', async () => {
  // response with an empty object -> no booking, no totalNet, no reference
  const fetchJson = makeFetch({});
  const offerNoRate = { id: 'HB-999', price: { total: 111, currency: 'GBP' } };
  const adapter = createBedbankAdapter({
    apiKey: 'k', secret: 's', env: 'production', fetchJson, now: FIXED_NOW
  });

  const result = await adapter.book({ offer: offerNoRate, passengers: [LEAD], contact: CONTACT });

  assert.equal(result.providerRef, undefined);
  assert.deepEqual(result.bookedPrice, { total: 111, currency: 'GBP' });
  assert.equal(result.live, true);

  const { url, options } = fetchJson.calls[0];
  assert.equal(url, 'https://api.hotelbeds.com/hotel-api/1.0/bookings'); // production base
  const body = JSON.parse(options.body);
  assert.equal(body.rooms[0].rateKey, 'HB-999'); // fell back to offer.id
});

test('live book uses response currency fallback when totalNet lacks currency', async () => {
  const fetchJson = makeFetch({ booking: { reference: 'BK-1', totalNet: 300 } });
  const adapter = createBedbankAdapter({ apiKey: 'k', secret: 's', fetchJson, now: FIXED_NOW });
  const result = await adapter.book({ offer: OFFER, passengers: [LEAD], contact: CONTACT });
  assert.deepEqual(result.bookedPrice, { total: 300, currency: 'EUR' }); // currency from offer
});

test('live book uses offer.id rateKey when details present but rateKey missing', async () => {
  const fetchJson = makeFetch({ booking: { reference: 'BK-2', totalNet: 10, currency: 'EUR' } });
  const offer = { id: 'HB-ABC', price: { total: 10, currency: 'EUR' }, details: {} };
  const adapter = createBedbankAdapter({ apiKey: 'k', secret: 's', fetchJson, now: FIXED_NOW });
  await adapter.book({ offer, passengers: [LEAD], contact: CONTACT });
  const body = JSON.parse(fetchJson.calls[0].options.body);
  assert.equal(body.rooms[0].rateKey, 'HB-ABC');
});

test('live book uses default now clock when none injected', async () => {
  const fetchJson = makeFetch({ booking: { reference: 'BK-3', totalNet: 5, currency: 'EUR' } });
  const adapter = createBedbankAdapter({ apiKey: 'k', secret: 's', fetchJson }); // no now
  await adapter.book({ offer: OFFER, passengers: [LEAD], contact: CONTACT });
  const sig = fetchJson.calls[0].options.headers['X-Signature'];
  assert.equal(typeof sig, 'string');
  assert.ok(sig.length > 0);
});

test('live book wraps fetchJson failure as 502', async () => {
  const cause = new Error('socket hang up');
  const fetchJson = makeRejectingFetch(cause);
  const adapter = createBedbankAdapter({ apiKey: 'k', secret: 's', fetchJson, now: FIXED_NOW });

  await assert.rejects(
    () => adapter.book({ offer: OFFER, passengers: [LEAD], contact: CONTACT }),
    (err) => {
      assert.equal(err.statusCode, 502);
      assert.equal(err.message, 'The hotel could not be booked right now. Please try again.');
      assert.equal(err.cause, cause);
      assert.ok(!err.message.includes('socket'));
      return true;
    }
  );
});

// --- live cancel ------------------------------------------------------------

test('live cancel deletes signed request and reads refund', async () => {
  const fetchJson = makeFetch({ booking: { totalNet: 240.5, currency: 'USD' } });
  const adapter = createBedbankAdapter({ apiKey: 'k', secret: 's', fetchJson, now: FIXED_NOW });

  const result = await adapter.cancel({ providerRef: 'BK-987' });

  assert.deepEqual(result, {
    status: 'cancelled',
    refund: { amount: 240.5, currency: 'USD' },
    live: true
  });

  const { url, options } = fetchJson.calls[0];
  assert.equal(url, 'https://api.test.hotelbeds.com/hotel-api/1.0/bookings/BK-987');
  assert.equal(options.method, 'DELETE');
  assert.equal(options.headers['Api-key'], 'k');
  assert.ok(options.headers['X-Signature'].length > 0);
});

test('live cancel with no refund data returns null refund', async () => {
  const fetchJson = makeFetch({ booking: { reference: 'BK-987' } }); // no totalNet
  const adapter = createBedbankAdapter({ apiKey: 'k', secret: 's', fetchJson, now: FIXED_NOW });
  const result = await adapter.cancel({ providerRef: 'BK-987' });
  assert.deepEqual(result.refund, { amount: null, currency: null });
});

test('live cancel with totalNet but no currency yields null currency', async () => {
  const fetchJson = makeFetch({}); // no booking at all -> {} fallback
  const adapter = createBedbankAdapter({ apiKey: 'k', secret: 's', fetchJson, now: FIXED_NOW });
  const result = await adapter.cancel({ providerRef: 'BK-987' });
  assert.deepEqual(result.refund, { amount: null, currency: null });
});

test('live cancel currency fallback to null when totalNet present without currency', async () => {
  const fetchJson = makeFetch({ booking: { totalNet: 99 } });
  const adapter = createBedbankAdapter({ apiKey: 'k', secret: 's', fetchJson, now: FIXED_NOW });
  const result = await adapter.cancel({ providerRef: 'BK-987' });
  assert.deepEqual(result.refund, { amount: 99, currency: null });
});

test('live cancel wraps fetchJson failure as 502', async () => {
  const cause = new Error('gateway down');
  const fetchJson = makeRejectingFetch(cause);
  const adapter = createBedbankAdapter({ apiKey: 'k', secret: 's', fetchJson, now: FIXED_NOW });

  await assert.rejects(
    () => adapter.cancel({ providerRef: 'BK-987' }),
    (err) => {
      assert.equal(err.statusCode, 502);
      assert.equal(err.message, 'The booking could not be cancelled right now. Please try again.');
      assert.equal(err.cause, cause);
      return true;
    }
  );
});

// --- cancel validation ------------------------------------------------------

test('cancel rejects missing booking reference with 400', async () => {
  const adapter = createBedbankAdapter();
  for (const providerRef of [undefined, '', '   ', 123]) {
    const call = providerRef === undefined
      ? () => adapter.cancel()
      : () => adapter.cancel({ providerRef });
    await assert.rejects(call, (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.message, 'A booking reference is required to cancel');
      return true;
    });
  }
});
