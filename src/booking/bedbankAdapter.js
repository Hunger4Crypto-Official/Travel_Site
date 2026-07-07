// Bedbank (Hotelbeds APItude style) booking adapter.
//
// Factory-built and dependency-injected in the same shape as the notifier:
// the caller supplies `fetchJson` (so tests never touch the network) and a
// `now` clock (so the request signature is deterministic under test). When no
// apiKey/secret pair is provided the adapter runs in a sandbox simulation and
// makes no network calls at all.
//
// --- Real Hotelbeds booking flow -------------------------------------------
//
// Hotelbeds APItude is a two-step flow: you first check a cached rate
// (CheckRate) to obtain a fresh `rateKey`, then confirm the booking by POSTing
// to the Booking endpoint with that rateKey plus holder and pax details. Here
// we assume the caller already holds a valid `rateKey` on the offer (or we
// fall back to the offer id) and perform the confirming POST directly.
//
//   POST https://api.hotelbeds.com/hotel-api/1.0/bookings          (production)
//   POST https://api.test.hotelbeds.com/hotel-api/1.0/bookings     (test)
//   DELETE .../hotel-api/1.0/bookings/{reference}                  (cancel)
//
// --- X-Signature scheme -----------------------------------------------------
//
// Every request is authenticated with an Api-key header and an X-Signature
// header. The signature is the SHA-256 hex digest of the concatenation of the
// public API key, the shared secret, and the current time in whole Unix
// seconds:
//
//   X-Signature = sha256hex( apiKey + secret + floor(Date.now() / 1000) )
//
// The signature is time-bounded, so it is recomputed for each call from the
// injected `now` clock.

import { createHash } from 'node:crypto';

const PROD_BASE = 'https://api.hotelbeds.com/hotel-api/1.0';
const TEST_BASE = 'https://api.test.hotelbeds.com/hotel-api/1.0';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function clientError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

export function createBedbankAdapter({
  apiKey = null,
  secret = null,
  env = 'test',
  fetchJson = null,
  now = () => Date.now()
} = {}) {
  const live = Boolean(apiKey && secret);
  const baseUrl = env === 'production' ? PROD_BASE : TEST_BASE;

  function signature() {
    const stamp = Math.floor(now() / 1000);
    return createHash('sha256').update(apiKey + secret + stamp).digest('hex');
  }

  function authHeaders() {
    return {
      'Api-key': apiKey,
      'X-Signature': signature(),
      'Content-Type': 'application/json',
      Accept: 'application/json'
    };
  }

  async function book({ offer, passengers, contact } = {}) {
    if (!offer || typeof offer !== 'object' || typeof offer.id !== 'string' ||
        !offer.price || typeof offer.price !== 'object') {
      throw clientError('A valid hotel offer is required to book');
    }

    const lead = Array.isArray(passengers) ? passengers[0] : null;
    if (!lead || typeof lead.givenName !== 'string' || lead.givenName.trim() === '' ||
        typeof lead.familyName !== 'string' || lead.familyName.trim() === '') {
      throw clientError('A lead guest with a given and family name is required');
    }

    if (!contact || typeof contact.email !== 'string' || !EMAIL_RE.test(contact.email)) {
      throw clientError('A contact email is required to book');
    }

    if (!live) {
      const confirmation = createHash('sha1')
        .update(offer.id)
        .digest('hex')
        .slice(0, 8)
        .toUpperCase();
      return {
        providerRef: `hotelbeds_sandbox_${offer.id}`,
        confirmation,
        status: 'confirmed',
        bookedPrice: { total: offer.price.total, currency: offer.price.currency },
        live: false
      };
    }

    const body = {
      holder: { name: lead.givenName, surname: lead.familyName },
      rooms: [{
        rateKey: offer.details?.rateKey ?? offer.id,
        paxes: [{ roomId: 1, type: 'AD', name: lead.givenName, surname: lead.familyName }]
      }],
      clientReference: 'THE-TRAVEL-CLUB'
    };

    let response;
    try {
      response = await fetchJson(`${baseUrl}/bookings`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(body)
      });
    } catch (err) {
      throw Object.assign(
        clientError('The hotel could not be booked right now. Please try again.', 502),
        { cause: err }
      );
    }

    const booking = response?.booking ?? {};
    const reference = booking.reference;
    const bookedPrice = booking.totalNet != null
      ? { total: booking.totalNet, currency: booking.currency ?? offer.price.currency }
      : { total: offer.price.total, currency: offer.price.currency };

    return {
      providerRef: reference,
      confirmation: reference,
      status: 'confirmed',
      bookedPrice,
      live: true
    };
  }

  async function cancel({ providerRef } = {}) {
    if (typeof providerRef !== 'string' || providerRef.trim() === '') {
      throw clientError('A booking reference is required to cancel');
    }

    if (!live) {
      return {
        status: 'cancelled',
        refund: { amount: null, currency: null },
        live: false
      };
    }

    let response;
    try {
      response = await fetchJson(`${baseUrl}/bookings/${providerRef}`, {
        method: 'DELETE',
        headers: authHeaders()
      });
    } catch (err) {
      throw Object.assign(
        clientError('The booking could not be cancelled right now. Please try again.', 502),
        { cause: err }
      );
    }

    const booking = response?.booking ?? {};
    const refund = booking.totalNet != null
      ? { amount: booking.totalNet, currency: booking.currency ?? null }
      : { amount: null, currency: null };

    return { status: 'cancelled', refund, live: true };
  }

  return {
    name: 'bedbank',
    supports: 'hotels',
    live,
    book,
    cancel
  };
}
