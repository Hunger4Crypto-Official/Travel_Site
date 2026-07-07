// Stripe billing gateway.
//
// Shape mirrors src/booking/duffelAdapter.js and src/utils/notifier.js: a
// factory that takes an injected network function (fetchJson) so it is trivially
// testable, supports a deterministic sandbox mode when no secret key is
// configured, and never leaks raw upstream errors to the caller. Client-facing
// strings avoid em dashes on purpose.
//
// --- Real Stripe endpoints (documented, sandbox short-circuits them) ---------
// Stripe's REST API accepts application/x-www-form-urlencoded request bodies and
// returns JSON. LIVE mode talks to:
//   POST   https://api.stripe.com/v1/customers          create a customer
//   POST   https://api.stripe.com/v1/subscriptions      start a subscription
//   DELETE https://api.stripe.com/v1/subscriptions/{id} cancel a subscription
//   POST   https://api.stripe.com/v1/payment_intents    charge a customer
// `priceId` is NOT an amount: it is a configured Stripe Price id (price_...)
// created ahead of time in the Stripe dashboard and mapped per membership tier.
// Amounts are charged in the currency's smallest unit (cents), hence the *100.

import { createHmac, timingSafeEqual } from 'node:crypto';

const CUSTOMERS_URL = 'https://api.stripe.com/v1/customers';
const SUBSCRIPTIONS_URL = 'https://api.stripe.com/v1/subscriptions';
const PAYMENT_INTENTS_URL = 'https://api.stripe.com/v1/payment_intents';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function upstreamFailure(cause) {
  const err = new Error('The payment provider could not be reached right now. Please try again.');
  err.statusCode = 502;
  if (cause) err.cause = cause;
  return err;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

export function createStripeGateway({ secretKey = null, fetchJson = null, now = () => Date.now() } = {}) {
  const live = Boolean(secretKey);

  // Issue a form-encoded POST/DELETE to Stripe, wrapping any rejection into a
  // client-safe 502 that keeps the raw upstream error on `.cause`.
  async function stripeRequest(url, method, form) {
    const options = {
      method,
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    };
    if (form) options.body = new URLSearchParams(form).toString();
    try {
      return await fetchJson(url, options);
    } catch (err) {
      throw upstreamFailure(err);
    }
  }

  async function createCustomer({ email, userId } = {}) {
    if (!isNonEmptyString(email) || !isNonEmptyString(userId)) {
      throw badRequest('A member email and id are required to set up billing');
    }

    if (!live) {
      return { customerId: `cus_sandbox_${userId}` };
    }

    const data = await stripeRequest(CUSTOMERS_URL, 'POST', {
      email,
      'metadata[userId]': userId
    });
    return { customerId: data.id };
  }

  async function createSubscription({ customerId, priceId, tierId } = {}) {
    if (!isNonEmptyString(customerId)) {
      throw badRequest('A billing customer is required');
    }

    if (!live) {
      return {
        subscriptionId: `sub_sandbox_${customerId}_${tierId}`,
        status: 'active',
        currentPeriodEnd: now() + THIRTY_DAYS_MS,
        tierId
      };
    }

    if (!isNonEmptyString(priceId)) {
      throw badRequest('A price is not configured for that tier');
    }

    const data = await stripeRequest(SUBSCRIPTIONS_URL, 'POST', {
      customer: customerId,
      'items[0][price]': priceId
    });
    return {
      subscriptionId: data.id,
      status: data.status,
      currentPeriodEnd: Number(data.current_period_end) * 1000,
      tierId
    };
  }

  async function cancelSubscription({ subscriptionId } = {}) {
    if (!isNonEmptyString(subscriptionId)) {
      throw badRequest('A subscription id is required to cancel');
    }

    if (!live) {
      return { subscriptionId, status: 'canceled' };
    }

    const data = await stripeRequest(
      `${SUBSCRIPTIONS_URL}/${encodeURIComponent(subscriptionId)}`,
      'DELETE',
      null
    );
    return { subscriptionId: data.id, status: data.status };
  }

  async function charge({ customerId, amount, currency = 'usd', description = null } = {}) {
    if (!isNonEmptyString(customerId) || typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      throw badRequest('A customer and a positive amount are required to charge');
    }

    if (!live) {
      return {
        paymentId: `pi_sandbox_${customerId}_${Math.round(amount * 100)}`,
        status: 'succeeded',
        amount,
        currency
      };
    }

    const form = {
      customer: customerId,
      amount: String(Math.round(amount * 100)),
      currency,
      confirm: 'true',
      'automatic_payment_methods[enabled]': 'true'
    };
    if (description !== null) form.description = description;

    const data = await stripeRequest(PAYMENT_INTENTS_URL, 'POST', form);
    return { paymentId: data.id, status: data.status, amount, currency };
  }

  // Verify a Stripe-Signature header against the raw request body. Never throws:
  // any parse/validation problem or crypto mismatch yields a plain false so the
  // caller can treat verification as a simple boolean gate.
  function verifyWebhookSignature({ payload, signature, secret, toleranceSec = 300 } = {}) {
    if (!isNonEmptyString(secret) || !isNonEmptyString(signature) || !isNonEmptyString(payload)) {
      return false;
    }

    let timestamp = null;
    const candidates = [];
    for (const part of signature.split(',')) {
      const idx = part.indexOf('=');
      if (idx === -1) continue;
      const key = part.slice(0, idx).trim();
      const value = part.slice(idx + 1).trim();
      if (key === 't') timestamp = value;
      else if (key === 'v1') candidates.push(value);
    }

    if (!isNonEmptyString(timestamp) || candidates.length === 0) return false;

    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) return false;
    if (Math.abs(Math.floor(now() / 1000) - ts) > toleranceSec) return false;

    const expected = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
    const expectedBuf = Buffer.from(expected, 'utf8');

    for (const candidate of candidates) {
      const candidateBuf = Buffer.from(candidate, 'utf8');
      // timingSafeEqual throws on unequal lengths; a length mismatch simply is
      // not a match, so skip it without throwing.
      if (candidateBuf.length !== expectedBuf.length) continue;
      if (timingSafeEqual(candidateBuf, expectedBuf)) return true;
    }
    return false;
  }

  function parseWebhookEvent(rawBody) {
    try {
      return JSON.parse(rawBody);
    } catch {
      throw badRequest('Invalid webhook payload');
    }
  }

  return {
    name: 'stripe',
    live,
    createCustomer,
    createSubscription,
    cancelSubscription,
    charge,
    verifyWebhookSignature,
    parseWebhookEvent
  };
}
