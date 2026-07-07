import test from 'node:test';
import assert from 'node:assert/strict';
import { createDuffelAdapter } from '../../src/booking/duffelAdapter.js';

// A minimal valid offer snapshot as produced by flight search.
function sampleOffer(overrides = {}) {
  return {
    type: 'flights',
    provider: 'duffel',
    id: 'off_0000AaBbCc',
    title: 'LHR to JFK',
    price: { total: 512.34, base: 400, taxes: 100, fees: 12.34, currency: 'GBP', estimated: false },
    details: {},
    ...overrides
  };
}

const validPassengers = [{ givenName: 'Ada', familyName: 'Lovelace' }];
const validContact = { email: 'ada@example.com' };

// --- Adapter shape ----------------------------------------------------------

test('adapter exposes name/supports and reports live=false without a token', () => {
  const adapter = createDuffelAdapter();
  assert.equal(adapter.name, 'duffel');
  assert.equal(adapter.supports, 'flights');
  assert.equal(adapter.live, false);
});

test('adapter reports live=true when a token is provided', () => {
  const adapter = createDuffelAdapter({ token: 'test_token' });
  assert.equal(adapter.live, true);
});

test('adapter exposes a default now() clock', () => {
  const adapter = createDuffelAdapter();
  assert.equal(typeof adapter.now(), 'number');
});

// --- Sandbox booking --------------------------------------------------------

test('sandbox book returns a deterministic simulated booking with no network', async () => {
  let called = false;
  const adapter = createDuffelAdapter({ fetchJson: () => { called = true; } });
  const offer = sampleOffer();

  const a = await adapter.book({ offer, passengers: validPassengers, contact: validContact });
  const b = await adapter.book({ offer, passengers: validPassengers, contact: validContact });

  assert.equal(called, false, 'sandbox must not touch the network');
  assert.equal(a.providerRef, `duffel_sandbox_${offer.id}`);
  assert.equal(a.status, 'confirmed');
  assert.equal(a.live, false);
  assert.deepEqual(a.bookedPrice, { total: offer.price.total, currency: offer.price.currency });
  assert.match(a.confirmation, /^[0-9A-Z]{6}$/, 'confirmation is 6-char uppercase base36');
  // Deterministic: identical across two calls.
  assert.equal(a.providerRef, b.providerRef);
  assert.equal(a.confirmation, b.confirmation);
});

// --- Sandbox cancel ---------------------------------------------------------

test('sandbox cancel returns a deterministic cancellation with no network', async () => {
  let called = false;
  const adapter = createDuffelAdapter({ fetchJson: () => { called = true; } });
  const result = await adapter.cancel({ providerRef: 'duffel_sandbox_off_1' });
  assert.equal(called, false);
  assert.deepEqual(result, { status: 'cancelled', refund: { amount: null, currency: null }, live: false });
});

// --- Validation errors ------------------------------------------------------

test('book rejects an invalid offer with a 400', async () => {
  const adapter = createDuffelAdapter();
  const cases = [
    undefined,
    null,
    'not-an-object',
    sampleOffer({ id: 123 }),      // id not a string
    { id: 'off_1' },               // no price
    sampleOffer({ price: 'nope' }) // price not an object
  ];
  for (const offer of cases) {
    await assert.rejects(
      () => adapter.book({ offer, passengers: validPassengers, contact: validContact }),
      (err) => {
        assert.equal(err.statusCode, 400);
        assert.equal(err.message, 'A valid flight offer is required to book');
        return true;
      }
    );
  }
});

test('book rejects missing or malformed passengers with a 400', async () => {
  const adapter = createDuffelAdapter();
  const cases = [
    null,                                             // not an array
    [],                                               // empty
    [null],                                           // falsy passenger
    [{ givenName: 42, familyName: 'X' }],             // givenName not a string
    [{ givenName: '   ', familyName: 'X' }],          // givenName blank
    [{ givenName: 'Ada', familyName: 55 }],           // familyName not a string
    [{ givenName: 'Ada' }],                           // familyName missing
    [{ givenName: 'Ada', familyName: '  ' }]          // familyName blank
  ];
  for (const passengers of cases) {
    await assert.rejects(
      () => adapter.book({ offer: sampleOffer(), passengers, contact: validContact }),
      (err) => {
        assert.equal(err.statusCode, 400);
        assert.equal(err.message, 'At least one passenger with a given and family name is required');
        return true;
      }
    );
  }
});

test('book rejects a missing or invalid contact email with a 400', async () => {
  const adapter = createDuffelAdapter();
  const cases = [
    undefined,             // no contact
    {},                    // email not a string
    { email: 'not-email' } // fails the shape regex
  ];
  for (const contact of cases) {
    await assert.rejects(
      () => adapter.book({ offer: sampleOffer(), passengers: validPassengers, contact }),
      (err) => {
        assert.equal(err.statusCode, 400);
        assert.equal(err.message, 'A contact email is required to book');
        return true;
      }
    );
  }
});

// --- Live booking -----------------------------------------------------------

test('live book posts to Duffel and maps the order response', async () => {
  const calls = [];
  const fetchJson = async (url, options) => {
    calls.push({ url, options });
    return {
      data: {
        id: 'ord_abc123',
        booking_reference: 'RF7QK2',
        total_amount: '540.00',
        total_currency: 'USD'
      }
    };
  };
  const adapter = createDuffelAdapter({ token: 'live_tok', fetchJson });
  const offer = sampleOffer();
  const result = await adapter.book({
    offer,
    passengers: [{ givenName: 'Ada', familyName: 'Lovelace' }],
    contact: validContact
  });

  assert.deepEqual(result, {
    providerRef: 'ord_abc123',
    confirmation: 'RF7QK2',
    status: 'confirmed',
    bookedPrice: { total: 540, currency: 'USD' },
    live: true
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.duffel.com/air/orders');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer live_tok');
  assert.equal(calls[0].options.headers['Duffel-Version'], 'v2');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body, {
    data: {
      type: 'instant',
      selected_offers: [offer.id],
      passengers: [{ type: 'adult', given_name: 'Ada', family_name: 'Lovelace' }],
      payments: [{ type: 'balance', amount: '512.34', currency: 'GBP' }]
    }
  });
});

test('live book falls back to the offer price when the order omits totals', async () => {
  const fetchJson = async () => null; // response has no data at all
  const adapter = createDuffelAdapter({ token: 'live_tok', fetchJson });
  const offer = sampleOffer();
  const result = await adapter.book({ offer, passengers: validPassengers, contact: validContact });

  assert.equal(result.providerRef, undefined);
  assert.equal(result.confirmation, undefined);
  assert.deepEqual(result.bookedPrice, { total: offer.price.total, currency: offer.price.currency });
  assert.equal(result.live, true);
});

test('live book wraps upstream failures into a 502 without leaking the cause', async () => {
  const raw = new Error('duffel 429 rate limited');
  const fetchJson = async () => { throw raw; };
  const adapter = createDuffelAdapter({ token: 'live_tok', fetchJson });
  await assert.rejects(
    () => adapter.book({ offer: sampleOffer(), passengers: validPassengers, contact: validContact }),
    (err) => {
      assert.equal(err.statusCode, 502);
      assert.equal(err.message, 'The flight could not be booked with the airline right now. Please try again.');
      assert.equal(err.cause, raw);
      return true;
    }
  );
});

// --- Live cancel ------------------------------------------------------------

test('live cancel posts to Duffel and maps the refund', async () => {
  const calls = [];
  const fetchJson = async (url, options) => {
    calls.push({ url, options });
    return { data: { refund_amount: '540.00', refund_currency: 'USD' } };
  };
  const adapter = createDuffelAdapter({ token: 'live_tok', fetchJson });
  const result = await adapter.cancel({ providerRef: 'ord_abc123' });

  assert.deepEqual(result, {
    status: 'cancelled',
    refund: { amount: '540.00', currency: 'USD' },
    live: true
  });
  assert.equal(calls[0].url, 'https://api.duffel.com/air/order_cancellations');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer live_tok');
  assert.deepEqual(JSON.parse(calls[0].options.body), { data: { order_id: 'ord_abc123' } });
});

test('live cancel defaults the refund to null when the response omits it', async () => {
  const fetchJson = async () => null;
  const adapter = createDuffelAdapter({ token: 'live_tok', fetchJson });
  const result = await adapter.cancel({ providerRef: 'ord_abc123' });
  assert.deepEqual(result, {
    status: 'cancelled',
    refund: { amount: null, currency: null },
    live: true
  });
});

test('live cancel wraps upstream failures into a 502', async () => {
  const raw = new Error('network down');
  const fetchJson = async () => { throw raw; };
  const adapter = createDuffelAdapter({ token: 'live_tok', fetchJson });
  await assert.rejects(
    () => adapter.cancel({ providerRef: 'ord_abc123' }),
    (err) => {
      assert.equal(err.statusCode, 502);
      assert.equal(err.message, 'The booking could not be cancelled right now. Please try again.');
      assert.equal(err.cause, raw);
      return true;
    }
  );
});

test('cancel rejects a missing booking reference with a 400', async () => {
  const adapter = createDuffelAdapter({ token: 'live_tok', fetchJson: async () => ({}) });
  for (const providerRef of [undefined, '', '   ', 42]) {
    await assert.rejects(
      () => adapter.cancel({ providerRef }),
      (err) => {
        assert.equal(err.statusCode, 400);
        assert.equal(err.message, 'A booking reference is required to cancel');
        return true;
      }
    );
  }
});
