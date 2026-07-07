import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockOffer, verifyOfferLock } from '../../src/booking/offerLock.js';

const SECRET = 'offer-lock-secret';
const offer = () => ({ type: 'flights', id: 'off_1', price: { total: 300, currency: 'USD' } });

test('lockOffer produces a lock a matching verify accepts', () => {
  const o = offer();
  o.lock = lockOffer(SECRET, o, { now: () => 1000 });
  assert.equal(typeof o.lock.sig, 'string');
  assert.equal(o.lock.exp, 1000 + 30 * 60 * 1000);
  assert.equal(verifyOfferLock(SECRET, o, { now: () => 2000 }), true);
});

test('verifyOfferLock rejects missing, malformed, expired, wrong-secret, and tampered locks', () => {
  const o = offer();
  o.lock = lockOffer(SECRET, o, { now: () => 1000 });

  assert.equal(verifyOfferLock(SECRET, { ...offer() }), false); // no lock at all
  assert.equal(verifyOfferLock(SECRET, { ...offer(), lock: { exp: 5000 } }), false); // sig not a string
  assert.equal(verifyOfferLock(SECRET, { ...offer(), lock: { sig: 'x', exp: 'soon' } }), false); // exp not a number
  assert.equal(verifyOfferLock(SECRET, o, { now: () => o.lock.exp + 1 }), false); // expired

  const tampered = { ...o, price: { total: 1, currency: 'USD' } }; // same-length canonical, wrong price
  assert.equal(verifyOfferLock(SECRET, tampered, { now: () => 2000 }), false);

  assert.equal(verifyOfferLock('different-secret', o, { now: () => 2000 }), false); // wrong secret

  // A signature of a different length fails the length guard, not timingSafeEqual.
  assert.equal(verifyOfferLock(SECRET, { ...offer(), lock: { sig: 'short', exp: 9e15 } }), false);
});

test('lockOffer tolerates an offer with no price and uses defaults', () => {
  const bare = { type: 'hotels', id: 'h1' };
  bare.lock = lockOffer(SECRET, bare); // default now()/ttl
  assert.equal(verifyOfferLock(SECRET, bare), true);
});
