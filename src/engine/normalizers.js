// Builds a comparable price. `total` is the all-in number used for ranking;
// `amount` stays as the headline/displayed price for backward compatibility.
// `estimated` marks prices that are NOT a verified all-in total (e.g. cached
// fares or fare-only quotes) so the engine can refuse to call them "comparable".
export function normalizePrice(value, currency = 'USD') {
  if (value && typeof value === 'object') {
    return normalizePriceObject(value, currency);
  }
  const amount = Number(value);
  const safe = Number.isFinite(amount) ? amount : null;
  return { amount: safe, currency, total: safe, base: null, taxes: null, fees: null, estimated: false };
}

function normalizePriceObject(value, fallbackCurrency) {
  const currency = (value.currency || fallbackCurrency || 'USD').toUpperCase();
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const base = num(value.base);
  const taxes = num(value.taxes);
  const fees = num(value.fees);
  const explicitTotal = num(value.total);
  const amount = num(value.amount) ?? explicitTotal ?? base;
  // Prefer an explicit total; otherwise sum components when present; else amount.
  const summed = base !== null ? base + (taxes || 0) + (fees || 0) : null;
  const total = explicitTotal ?? summed ?? amount;
  return {
    amount: amount ?? total,
    currency,
    total,
    base,
    taxes,
    fees,
    estimated: Boolean(value.estimated)
  };
}

export function normalizeOffer({
  type,
  provider,
  id,
  price,
  currency = 'USD',
  title,
  deepLink,
  affiliateId,
  details = {},
  score,
  freshness = 'live'
}) {
  return {
    id: id || `${provider}-${type}-${Math.random().toString(36).slice(2)}`,
    type,
    provider,
    title,
    price: normalizePrice(price, currency),
    deepLink: deepLink || null,
    affiliate: affiliateId ? { id: affiliateId } : null,
    details,
    score: score ?? null,
    freshness,
    fetchedAt: new Date().toISOString()
  };
}

// The number offers are compared on.
export function comparableAmount(offer) {
  const price = offer?.price;
  if (!price) return null;
  return price.total ?? price.amount ?? null;
}
