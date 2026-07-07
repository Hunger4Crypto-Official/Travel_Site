import { getTier } from '../accounts/membership.js';
import { verifyOfferLock } from './offerLock.js';

const SUPPORTED = new Set(['flights', 'hotels', 'cars']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_FEE_RATE = 0.02; // 2% booking service fee, waived for the top tier.
const MAX_PASSENGERS = 9;
// Cancellation is as easy as booking (FTC click-to-cancel expectation), stated
// upfront on every order.
const CANCELLATION_POLICY = 'Cancel anytime from your trips. Any refund follows the provider policy and is shown when you cancel.';

// Orchestrates booking over an OrderStore and a set of aggregator adapters
// (Duffel for flights, a bedbank for hotels). The adapter is the merchant of
// record; this service owns validation, the tier-aware service fee, owner
// scoping, and the order lifecycle (pending -> confirmed/failed -> cancelled).
export class BookingService {
  constructor({ store, adapters = [], loyalty = null, offerSecret = null, now = () => Date.now(), feeRate = DEFAULT_FEE_RATE } = {}) {
    this.store = store;
    this.loyalty = loyalty;
    // When set, every booked offer must carry a valid server-issued lock, so a
    // client cannot fabricate an offer or tamper with its price.
    this.offerSecret = offerSecret;
    this.now = now;
    this.feeRate = feeRate;
    this.adapters = new Map();
    for (const adapter of adapters) this.adapters.set(adapter.supports, adapter);
  }

  adapterFor(type) {
    return this.adapters.get(type) || null;
  }

  async createOrder(input = {}, context = {}) {
    const type = input.type;
    if (!SUPPORTED.has(type)) {
      throw badRequest('type must be one of flights, hotels, cars');
    }
    const adapter = this.adapterFor(type);
    if (!adapter) throw badRequest(`Booking is not available for ${type} yet`);

    const offer = input.offer;
    if (!offer || typeof offer !== 'object' || typeof offer.id !== 'string' || !offer.price || typeof offer.price !== 'object') {
      throw badRequest('A valid offer is required to book');
    }
    // The offer must be one we issued and priced, unchanged. This blocks
    // fabricated offers and price tampering (loyalty/fee forgery).
    if (this.offerSecret && !verifyOfferLock(this.offerSecret, offer, { now: this.now })) {
      throw badRequest('This offer could not be verified. Please search again and book from the results.');
    }
    const passengers = normalizePassengers(input.passengers);
    const contact = normalizeContact(input.contact);
    const owner = ownerOf(context);
    const tierId = typeof context.tier === 'string' ? context.tier : 'free';
    const serviceFee = this.serviceFee(offer.price.total, tierId);
    const priceSnapshot = { ...offer.price };
    const snapshot = offerSnapshot(offer);

    let booking;
    try {
      booking = await adapter.book({ offer, passengers, contact });
    } catch (err) {
      // Persist the failed attempt so it is auditable, then surface the error.
      this.store.create({
        owner, type, status: 'failed', provider: adapter.name, offer: snapshot,
        passengers, contact, price: priceSnapshot, serviceFee, total: null,
        providerRef: null, confirmation: null, bookedPrice: null, live: adapter.live,
        lastError: err.message,
        history: [{ at: this.now(), status: 'failed', note: 'Booking attempt failed' }]
      });
      throw err;
    }

    const status = booking.status || 'confirmed';
    const order = this.store.create({
      owner, type, status, provider: adapter.name, offer: snapshot,
      passengers, contact, price: priceSnapshot, serviceFee,
      total: round2(numberOr(offer.price.total, 0) + serviceFee),
      providerRef: booking.providerRef, confirmation: booking.confirmation,
      bookedPrice: booking.bookedPrice || null, live: booking.live ?? adapter.live,
      cancellationPolicy: CANCELLATION_POLICY,
      lastError: null,
      history: [{ at: this.now(), status, note: 'Booked' }]
    });

    // Award loyalty points to the signed-in member who booked.
    if (this.loyalty) {
      const earned = this.loyalty.earnForBooking(order.owner, order);
      if (earned) return publicOrder(this.store.update(order.id, { loyaltyEarned: earned.points }));
    }
    return publicOrder(order);
  }

  getOrder(id, context = {}) {
    const order = this.store.get(id);
    if (!order || order.owner !== ownerOf(context)) throw notFound('Order not found');
    return publicOrder(order);
  }

  listOrders(context = {}) {
    const orders = this.store.list(ownerOf(context)).map(publicOrder);
    return { orders, count: orders.length };
  }

  async cancelOrder(id, context = {}) {
    const order = this.store.get(id);
    if (!order || order.owner !== ownerOf(context)) throw notFound('Order not found');
    if (order.status === 'cancelled') return publicOrder(order);

    const adapter = this.adapterFor(order.type);
    if (!adapter) throw badRequest(`Cancellation is not available for ${order.type}`);
    const result = await adapter.cancel({ providerRef: order.providerRef });
    // Claw back any loyalty points awarded for this order so a book-then-cancel
    // loop cannot mint free credit.
    if (this.loyalty && order.loyaltyEarned) this.loyalty.reverseForBooking(order.owner, order);
    const updated = this.store.update(id, {
      status: 'cancelled', cancelledAt: this.now(), refund: result.refund || null,
      history: [...(order.history || []), { at: this.now(), status: 'cancelled', note: 'Cancelled' }]
    });
    return publicOrder(updated);
  }

  // Globetrotter (gold) has waived booking service fees; every other tier pays
  // a flat percentage of the trip total, disclosed separately in the order.
  serviceFee(total, tierId) {
    const tier = getTier(tierId);
    if (tier && tier.id === 'gold') return 0;
    return round2(numberOr(total, 0) * this.feeRate);
  }
}

function normalizePassengers(list) {
  if (!Array.isArray(list) || list.length === 0) {
    throw badRequest('At least one passenger is required to book');
  }
  if (list.length > MAX_PASSENGERS) {
    throw badRequest(`At most ${MAX_PASSENGERS} passengers per booking`);
  }
  return list.map((passenger) => {
    const givenName = typeof passenger?.givenName === 'string' ? passenger.givenName.trim() : '';
    const familyName = typeof passenger?.familyName === 'string' ? passenger.familyName.trim() : '';
    if (!givenName || !familyName) {
      throw badRequest('Each passenger needs a given name and a family name');
    }
    return { givenName, familyName };
  });
}

function normalizeContact(contact) {
  const email = typeof contact?.email === 'string' ? contact.email.trim() : '';
  if (!EMAIL_RE.test(email)) {
    throw badRequest('A valid contact email is required to book');
  }
  const phone = typeof contact?.phone === 'string' ? contact.phone.trim() : null;
  return { email: email.toLowerCase(), phone };
}

function offerSnapshot(offer) {
  return {
    id: offer.id,
    provider: offer.provider ?? null,
    title: offer.title ?? null,
    deepLink: offer.deepLink ?? null,
    details: offer.details ?? null
  };
}

// The order shape returned toward a response. It is always the caller's own
// order (owner-scoped), so it echoes the booking detail in full.
export function publicOrder(order) {
  return {
    id: order.id,
    type: order.type,
    status: order.status,
    provider: order.provider,
    confirmation: order.confirmation,
    providerRef: order.providerRef,
    offer: order.offer,
    passengers: order.passengers,
    contact: order.contact,
    price: order.price,
    serviceFee: order.serviceFee,
    total: order.total,
    bookedPrice: order.bookedPrice ?? null,
    loyaltyEarned: order.loyaltyEarned ?? 0,
    cancellationPolicy: order.cancellationPolicy ?? null,
    refund: order.refund ?? null,
    live: order.live,
    lastError: order.lastError ?? null,
    history: order.history ?? [],
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    cancelledAt: order.cancelledAt ?? null
  };
}

function ownerOf(context) {
  return context.principal || 'anonymous';
}

function numberOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function notFound(message) {
  const err = new Error(message);
  err.statusCode = 404;
  return err;
}
