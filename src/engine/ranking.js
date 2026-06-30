import { comparableAmount } from './normalizers.js';

// Ranks by all-in comparable total (lowest first) by default. `sort=score`
// ranks by score first. Live data is preferred over cached as a final tiebreak.
export function rankOffers(offers, { sort = 'price' } = {}) {
  return [...offers].sort((a, b) => {
    if (sort === 'score') {
      const scoreDiff = (b.score ?? 0) - (a.score ?? 0);
      if (scoreDiff !== 0) return scoreDiff;
    }

    const aPrice = comparableAmount(a) ?? Number.POSITIVE_INFINITY;
    const bPrice = comparableAmount(b) ?? Number.POSITIVE_INFINITY;
    if (aPrice !== bPrice) return aPrice - bPrice;

    const scoreDiff = (b.score ?? 0) - (a.score ?? 0);
    if (scoreDiff !== 0) return scoreDiff;

    return freshnessRank(b) - freshnessRank(a);
  });
}

function freshnessRank(offer) {
  return offer?.freshness === 'live' ? 1 : 0;
}
