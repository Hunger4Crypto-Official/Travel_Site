export function normalizePrice(value, currency = 'USD') {
  const amount = Number(value);
  return { amount: Number.isFinite(amount) ? amount : null, currency };
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
  score
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
    fetchedAt: new Date().toISOString()
  };
}
