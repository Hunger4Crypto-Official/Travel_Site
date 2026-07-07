import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrderStore } from '../../src/booking/orderStore.js';
import { BookingService, publicOrder } from '../../src/booking/bookingService.js';

function offer(over = {}) {
  return {
    type: 'flights', id: 'off_1', provider: 'duffel', title: 'LAX to JFK',
    price: { total: 200, base: 170, taxes: 30, fees: 0, currency: 'USD', estimated: false },
    details: { seat: '12A' }, deepLink: 'https://book.example/off_1', ...over
  };
}
const goodPax = [{ givenName: 'Ada', familyName: 'Lovelace' }];
const goodContact = { email: 'ada@example.com', phone: '+1 555 0100' };

function fakeAdapter(over = {}) {
  const calls = { book: 0, cancel: 0 };
  return {
    calls,
    name: over.name || 'fake',
    supports: over.supports || 'flights',
    live: over.live ?? false,
    book: over.book || (async ({ offer: o }) => { calls.book++; return { providerRef: `ref_${o.id}`, confirmation: 'CONF123', status: 'confirmed', bookedPrice: { total: o.price.total, currency: o.price.currency }, live: false }; }),
    cancel: over.cancel || (async () => { calls.cancel++; return { status: 'cancelled', refund: { amount: 25, currency: 'USD' } }; })
  };
}

function makeService(adapters, opts = {}) {
  const store = new OrderStore({ now: opts.now || (() => 1000), idFactory: (() => { let n = 0; return () => `o${++n}`; })() });
  return { store, service: new BookingService({ store, adapters, now: opts.now || (() => 1000) }) };
}

test('createOrder books, adds a tier-aware service fee, and returns the order', async () => {
  const adapter = fakeAdapter();
  const { service } = makeService([adapter]);
  const order = await service.createOrder(
    { type: 'flights', offer: offer(), passengers: goodPax, contact: goodContact },
    { principal: 'user:1', tier: 'free' }
  );
  assert.equal(order.status, 'confirmed');
  assert.equal(order.provider, 'fake');
  assert.equal(order.confirmation, 'CONF123');
  assert.equal(order.serviceFee, 4, '2% of 200');
  assert.equal(order.total, 204);
  assert.equal(order.contact.email, 'ada@example.com');
  assert.equal(order.passengers[0].familyName, 'Lovelace');
  assert.equal(order.history.at(-1).status, 'confirmed');
});

test('a wired loyalty service earns points for members and is skipped for non-members', async () => {
  const seen = [];
  const loyalty = { earnForBooking: (owner) => { seen.push(owner); return owner.startsWith('user:') ? { points: 42 } : null; } };
  const { service } = makeService([fakeAdapter()]);
  service.loyalty = loyalty;
  const member = await service.createOrder({ type: 'flights', offer: offer(), passengers: goodPax, contact: goodContact }, { principal: 'user:1', tier: 'free' });
  assert.equal(member.loyaltyEarned, 42);
  const anon = await service.createOrder({ type: 'flights', offer: offer(), passengers: goodPax, contact: goodContact }, { principal: 'anonymous', tier: 'free' });
  assert.equal(anon.loyaltyEarned, 0);
  assert.deepEqual(seen, ['user:1', 'anonymous']);
});

test('the gold tier has its booking service fee waived', async () => {
  const { service } = makeService([fakeAdapter()]);
  const order = await service.createOrder(
    { type: 'flights', offer: offer(), passengers: goodPax, contact: goodContact },
    { principal: 'user:1', tier: 'gold' }
  );
  assert.equal(order.serviceFee, 0);
  assert.equal(order.total, 200);
});

test('createOrder validates type, adapter availability, offer, passengers, and contact', async () => {
  const { service } = makeService([fakeAdapter({ supports: 'flights' })]);
  const base = { offer: offer(), passengers: goodPax, contact: goodContact };
  await assert.rejects(() => service.createOrder({ ...base, type: 'cruises' }, {}), (e) => e.statusCode === 400);
  await assert.rejects(() => service.createOrder({ ...base, type: 'cars' }, {}), (e) => /not available for cars/.test(e.message) && e.statusCode === 400);
  await assert.rejects(() => service.createOrder({ type: 'flights', passengers: goodPax, contact: goodContact }, {}), (e) => e.statusCode === 400);
  await assert.rejects(() => service.createOrder({ type: 'flights', offer: { id: 'x' }, passengers: goodPax, contact: goodContact }, {}), (e) => e.statusCode === 400);
  await assert.rejects(() => service.createOrder({ type: 'flights', offer: offer(), passengers: [], contact: goodContact }, {}), (e) => e.statusCode === 400);
  await assert.rejects(() => service.createOrder({ type: 'flights', offer: offer(), passengers: [{ givenName: 'A' }], contact: goodContact }, {}), (e) => e.statusCode === 400);
  await assert.rejects(() => service.createOrder({ type: 'flights', offer: offer(), passengers: [{ familyName: 'X' }], contact: goodContact }, {}), (e) => e.statusCode === 400); // non-string givenName
  await assert.rejects(() => service.createOrder({ type: 'flights', offer: offer(), passengers: goodPax, contact: { email: 'nope' } }, {}), (e) => e.statusCode === 400);
  await assert.rejects(() => service.createOrder({ type: 'flights', offer: offer(), passengers: goodPax, contact: { phone: '555' } }, {}), (e) => e.statusCode === 400); // missing email
});

test('optional fields fall back: minimal offer + minimal booking result + no tier', async () => {
  const minimal = fakeAdapter({ book: async ({ offer: o }) => ({ providerRef: `r_${o.id}`, confirmation: 'C' }) });
  const { service } = makeService([minimal]);
  const order = await service.createOrder(
    { type: 'flights', offer: { type: 'flights', id: 'min_1', price: { total: 100, currency: 'USD' } }, passengers: goodPax, contact: { email: 'a@b.com' } },
    { principal: 'user:1' } // no tier -> free
  );
  assert.equal(order.status, 'confirmed'); // booking.status || 'confirmed'
  assert.equal(order.bookedPrice, null); // booking.bookedPrice || null
  assert.equal(order.live, false); // booking.live ?? adapter.live
  assert.equal(order.serviceFee, 2); // free tier, 2% of 100
  assert.equal(order.offer.provider, null);
  assert.equal(order.offer.title, null);
  assert.equal(order.offer.deepLink, null);
  assert.equal(order.offer.details, null);
  assert.equal(service.listOrders({}).count, 0); // anonymous owner fallback
});

test('cancel tolerates a loaded order with no history and an adapter refund of none', async () => {
  const adapter = fakeAdapter({ cancel: async () => ({ status: 'cancelled' }) }); // no refund
  const { service, store } = makeService([adapter]);
  store.byId.set('x', { id: 'x', owner: 'user:1', type: 'flights', status: 'confirmed', providerRef: 'r', createdAt: 1, updatedAt: 1 });
  const cancelled = await service.cancelOrder('x', { principal: 'user:1' });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.refund, null); // result.refund || null
  assert.equal(cancelled.history.length, 1); // [...(order.history || []), cancelled]
});

test('a failed booking persists an auditable failed order and rethrows', async () => {
  const boom = fakeAdapter({ book: async () => { const e = new Error('The flight could not be booked with the airline right now. Please try again.'); e.statusCode = 502; throw e; } });
  const { service, store } = makeService([boom]);
  await assert.rejects(
    () => service.createOrder({ type: 'flights', offer: offer(), passengers: goodPax, contact: goodContact }, { principal: 'user:9', tier: 'free' }),
    (e) => e.statusCode === 502
  );
  const failed = store.list('user:9');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].status, 'failed');
  assert.match(failed[0].lastError, /could not be booked/);
  assert.equal(failed[0].total, null);
});

test('getOrder and listOrders are owner-scoped', async () => {
  const { service } = makeService([fakeAdapter()]);
  const mine = await service.createOrder({ type: 'flights', offer: offer(), passengers: goodPax, contact: goodContact }, { principal: 'user:1', tier: 'free' });
  assert.equal(service.getOrder(mine.id, { principal: 'user:1' }).id, mine.id);
  assert.throws(() => service.getOrder(mine.id, { principal: 'user:2' }), (e) => e.statusCode === 404);
  assert.throws(() => service.getOrder('ghost', { principal: 'user:1' }), (e) => e.statusCode === 404);
  assert.equal(service.listOrders({ principal: 'user:1' }).count, 1);
  assert.equal(service.listOrders({ principal: 'user:2' }).count, 0);
});

test('cancelOrder cancels once, is idempotent, and stays owner-scoped', async () => {
  const adapter = fakeAdapter();
  const { service } = makeService([adapter]);
  const order = await service.createOrder({ type: 'flights', offer: offer(), passengers: goodPax, contact: goodContact }, { principal: 'user:1', tier: 'free' });

  await assert.rejects(() => service.cancelOrder(order.id, { principal: 'user:2' }), (e) => e.statusCode === 404);
  await assert.rejects(() => service.cancelOrder('ghost', { principal: 'user:1' }), (e) => e.statusCode === 404);

  const cancelled = await service.cancelOrder(order.id, { principal: 'user:1' });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.refund.amount, 25);
  assert.equal(cancelled.cancelledAt, 1000);
  assert.equal(adapter.calls.cancel, 1);

  // Cancelling again returns the cancelled order without calling the adapter.
  const again = await service.cancelOrder(order.id, { principal: 'user:1' });
  assert.equal(again.status, 'cancelled');
  assert.equal(adapter.calls.cancel, 1, 'adapter.cancel is not called a second time');
});

test('cancelOrder 400s when no adapter serves the order type', async () => {
  const adapter = fakeAdapter();
  const { service } = makeService([adapter]);
  const order = await service.createOrder({ type: 'flights', offer: offer(), passengers: goodPax, contact: goodContact }, { principal: 'user:1', tier: 'free' });
  service.adapters.delete('flights'); // simulate an adapter that is no longer configured
  await assert.rejects(() => service.cancelOrder(order.id, { principal: 'user:1' }), (e) => e.statusCode === 400);
});

test('serviceFee: percentage for standard tiers, waived for gold, zero for a non-finite total', () => {
  const { service } = makeService([fakeAdapter()]);
  assert.equal(service.serviceFee(100, 'free'), 2);
  assert.equal(service.serviceFee(100, 'silver'), 2);
  assert.equal(service.serviceFee(100, 'gold'), 0);
  assert.equal(service.serviceFee(100, 'unknown-tier'), 2);
  assert.equal(service.serviceFee(undefined, 'free'), 0);
});

test('publicOrder exposes the booking detail and defaults optional fields', () => {
  const shaped = publicOrder({ id: 'o', type: 'flights', status: 'confirmed', provider: 'fake', createdAt: 1, updatedAt: 1 });
  assert.equal(shaped.refund, null);
  assert.equal(shaped.bookedPrice, null);
  assert.equal(shaped.lastError, null);
  assert.deepEqual(shaped.history, []);
  assert.equal(shaped.cancelledAt, null);
});
