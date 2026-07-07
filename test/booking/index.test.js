import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBookingService, serializeBody } from '../../src/booking/index.js';

const baseConfig = {
  bookingEnabled: true, ordersFile: null, ordersMaxEntries: 100,
  duffelToken: null, duffelEnv: 'test',
  hotelbedsApiKey: null, hotelbedsSecret: null, hotelbedsEnv: 'test',
  providerTimeoutMs: 8000
};

test('serializeBody stringifies objects and passes strings/empties through', () => {
  assert.equal(serializeBody({ a: 1 }), '{"a":1}');
  assert.equal(serializeBody('already'), 'already');
  assert.equal(serializeBody(null), null);
  assert.equal(serializeBody(undefined), undefined);
});

test('createBookingService returns null when disabled and wires both adapters when enabled', () => {
  assert.equal(createBookingService({ ...baseConfig, bookingEnabled: false }), null);
  const svc = createBookingService(baseConfig);
  assert.deepEqual([...svc.adapters.keys()].sort(), ['flights', 'hotels']);
});

test('the injected fetch is used for live bookings, with an object body serialized to a string', async () => {
  const captured = [];
  const fakeFetch = async (url, opts) => {
    captured.push({ url, opts });
    return { data: { id: 'duf_1', booking_reference: 'REF9', total_amount: '300.00', total_currency: 'USD' } };
  };
  const svc = createBookingService({ ...baseConfig, duffelToken: 'live-token' }, { fetchJson: fakeFetch });
  const order = await svc.createOrder(
    { type: 'flights', offer: { type: 'flights', id: 'duf_1', price: { total: 300, currency: 'USD' } }, passengers: [{ givenName: 'Ada', familyName: 'Lovelace' }], contact: { email: 'ada@example.com' } },
    { principal: 'user:1' }
  );
  assert.equal(order.confirmation, 'REF9');
  assert.equal(order.live, true);
  assert.equal(captured.length, 1);
  assert.equal(typeof captured[0].opts.body, 'string', 'the object body was serialized');
  assert.equal(captured[0].opts.timeoutMs, 8000);
});
