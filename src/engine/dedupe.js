import { comparableAmount } from './normalizers.js';

// A stable identity for an offer so the same real-world product sold by several
// providers collapses into one comparison row. Returns null when the offer
// can't be confidently matched (then it is never merged with another).
export function canonicalKey(offer) {
  const d = offer.details || {};
  switch (offer.type) {
    case 'flights': {
      if (Array.isArray(d.segments) && d.segments.length) {
        const legs = d.segments.map((s) =>
          `${String(s.carrier || '').toUpperCase()}${s.number || ''}@${String(s.at || '').slice(0, 10)}|${s.from || ''}-${s.to || ''}`);
        return `flights:${legs.join('>')}`;
      }
      if (d.airline && d.flightNumber) {
        return `flights:${String(d.airline).toUpperCase()}${d.flightNumber}@${String(d.departureAt || '').slice(0, 10)}|${d.origin || ''}-${d.destination || ''}`;
      }
      return null;
    }
    case 'hotels':
      if (d.code !== undefined && d.code !== null) return `hotels:code:${d.code}`;
      if (offer.title) return `hotels:name:${offer.title.toLowerCase()}|${String(d.destination || d.city || '').toLowerCase()}`;
      return null;
    case 'airports': {
      const code = d.iata || d.icao;
      return code ? `airports:${String(code).toUpperCase()}` : null;
    }
    case 'tracking':
      return d.icao24 ? `tracking:${String(d.icao24).toLowerCase()}` : null;
    default:
      return null; // cars and unknown verticals: no cross-provider identity
  }
}

// Collapses equivalent offers, keeping the cheapest as the primary and listing
// the rest as `alternatives` so a consumer can still see every provider's price.
export function dedupeOffers(offers) {
  const groups = new Map();
  const passthrough = [];

  for (const offer of offers) {
    const key = canonicalKey(offer);
    if (!key) {
      passthrough.push({ ...offer, alternatives: [] });
      continue;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(offer);
  }

  const merged = [];
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) =>
      (comparableAmount(a) ?? Number.POSITIVE_INFINITY) - (comparableAmount(b) ?? Number.POSITIVE_INFINITY));
    const [primary, ...rest] = sorted;
    merged.push({
      ...primary,
      alternatives: rest.map((o) => ({ provider: o.provider, offerId: o.id, price: o.price, deepLink: o.deepLink || null }))
    });
  }

  return [...merged, ...passthrough];
}
