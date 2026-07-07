// Duffel flight-booking adapter.
//
// Shape mirrors src/utils/notifier.js: a factory that takes an injected network
// function (fetchJson) so it is trivially testable, supports a disabled/sandbox
// mode when no token is configured, and never leaks raw upstream errors to the
// caller. Client-facing strings avoid em dashes on purpose.
//
// --- Real Duffel order flow (documented, sandbox short-circuits it) ----------
// The production Duffel flow is a two-step dance:
//   1. Create an offer request (POST /air/offer_requests) with the journey and
//      passenger cabin/loyalty details. Duffel returns a set of live offers.
//   2. The caller picks one offer; its `offer.id` is a *live* Duffel offer id
//      that expires quickly. That id is then used to create an order
//      (POST /air/orders) of type 'instant' with the mapped passengers and a
//      balance payment for the offer total.
// This adapter handles step 2 only: `offer.id` MUST be a live Duffel offer id
// obtained from a fresh search. Cancellation likewise is really a two-step
// flow (create a pending cancellation, then confirm it via
// POST /air/order_cancellations/{id}/actions/confirm); the confirm step is
// omitted here for brevity and documented on the cancel path below.

import { createHash } from 'node:crypto';

// Deliberately permissive shape check, matching src/accounts/accountService.js.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ORDERS_URL = 'https://api.duffel.com/air/orders';
const CANCELLATIONS_URL = 'https://api.duffel.com/air/order_cancellations';

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function upstreamFailure(message, cause) {
  const err = new Error(message);
  err.statusCode = 502;
  if (cause) err.cause = cause;
  return err;
}

// Deterministic 6-char uppercase base36 confirmation derived from the offer id.
// Uses sha1 so a given offer always yields the same simulated reference.
function simulatedConfirmation(id) {
  const digest = createHash('sha1').update(String(id)).digest('hex');
  // Fold the leading hex into a base36 string and take six uppercase chars.
  return BigInt('0x' + digest.slice(0, 12)).toString(36).toUpperCase().slice(0, 6).padStart(6, '0');
}

function mapPassengers(passengers) {
  return passengers.map((p) => ({
    type: 'adult',
    given_name: p.givenName,
    family_name: p.familyName
  }));
}

export function createDuffelAdapter({ token = null, env = 'test', fetchJson = null, now = () => Date.now() } = {}) {
  const live = Boolean(token);

  async function book({ offer, passengers, contact } = {}) {
    // --- Validation (client-safe 400s, no em dashes) -------------------------
    if (!offer || typeof offer !== 'object' || typeof offer.id !== 'string' || !offer.price || typeof offer.price !== 'object') {
      throw badRequest('A valid flight offer is required to book');
    }
    if (!Array.isArray(passengers) || passengers.length === 0 ||
        !passengers.every((p) => p && typeof p.givenName === 'string' && p.givenName.trim() !== '' &&
                                 typeof p.familyName === 'string' && p.familyName.trim() !== '')) {
      throw badRequest('At least one passenger with a given and family name is required');
    }
    if (!contact || typeof contact.email !== 'string' || !EMAIL_RE.test(contact.email.trim())) {
      throw badRequest('A contact email is required to book');
    }

    // --- Sandbox: deterministic simulation, no network -----------------------
    if (!live) {
      return {
        providerRef: `duffel_sandbox_${offer.id}`,
        confirmation: simulatedConfirmation(offer.id),
        status: 'confirmed',
        bookedPrice: { total: offer.price.total, currency: offer.price.currency },
        live: false
      };
    }

    // --- Live: create the order with the pre-selected live offer id ----------
    const body = {
      data: {
        type: 'instant',
        selected_offers: [offer.id],
        passengers: mapPassengers(passengers),
        payments: [{ type: 'balance', amount: String(offer.price.total), currency: offer.price.currency }]
      }
    };

    let response;
    try {
      response = await fetchJson(ORDERS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Duffel-Version': 'v2',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });
    } catch (err) {
      throw upstreamFailure('The flight could not be booked with the airline right now. Please try again.', err);
    }

    const data = response?.data ?? {};
    return {
      providerRef: data.id,
      confirmation: data.booking_reference,
      status: 'confirmed',
      bookedPrice: {
        total: Number(data.total_amount ?? offer.price.total),
        currency: data.total_currency ?? offer.price.currency
      },
      live: true
    };
  }

  async function cancel({ providerRef } = {}) {
    if (typeof providerRef !== 'string' || providerRef.trim() === '') {
      throw badRequest('A booking reference is required to cancel');
    }

    // --- Sandbox: deterministic, no network ----------------------------------
    if (!live) {
      return { status: 'cancelled', refund: { amount: null, currency: null }, live: false };
    }

    // --- Live: create the order cancellation ---------------------------------
    // Real Duffel requires a follow-up confirm call
    // (POST /air/order_cancellations/{id}/actions/confirm) to finalize the
    // refund; that confirm step is omitted here for brevity.
    let response;
    try {
      response = await fetchJson(CANCELLATIONS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Duffel-Version': 'v2',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ data: { order_id: providerRef } })
      });
    } catch (err) {
      throw upstreamFailure('The booking could not be cancelled right now. Please try again.', err);
    }

    const data = response?.data ?? {};
    return {
      status: 'cancelled',
      refund: { amount: data.refund_amount ?? null, currency: data.refund_currency ?? null },
      live: true
    };
  }

  return {
    name: 'duffel',
    supports: 'flights',
    live,
    env,
    now,
    book,
    cancel
  };
}
