import { createHmac, timingSafeEqual } from 'node:crypto';

// Offers are handed to the client in a search response and handed back at
// booking time. Without integrity protection a caller can fabricate an offer or
// tamper with its price to farm loyalty points or dodge the service fee. Each
// search offer is therefore signed server-side over the fields that matter
// economically (type, id, total, currency) plus an expiry; booking refuses any
// offer whose lock is missing, tampered, or expired.

const DEFAULT_TTL_MS = 30 * 60 * 1000; // a locked price is bookable for 30 minutes.

function canonical(offer, exp) {
  const price = offer && offer.price ? offer.price : {};
  return `${offer?.type}|${offer?.id}|${price.total}|${price.currency}|${exp}`;
}

function sign(secret, offer, exp) {
  return createHmac('sha256', secret).update(canonical(offer, exp)).digest('base64url');
}

// Return the lock to attach to an offer: { exp, sig }.
export function lockOffer(secret, offer, { now = () => Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
  const exp = now() + ttlMs;
  return { exp, sig: sign(secret, offer, exp) };
}

// True only when offer.lock is present, unexpired, and signs the offer's own
// type/id/price under this secret. Never throws.
export function verifyOfferLock(secret, offer, { now = () => Date.now() } = {}) {
  const lock = offer && offer.lock;
  if (!lock || typeof lock.sig !== 'string' || typeof lock.exp !== 'number') return false;
  if (now() > lock.exp) return false;
  const expected = Buffer.from(sign(secret, offer, lock.exp));
  const provided = Buffer.from(lock.sig);
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}
