export function rankOffers(offers, { sort = 'price' } = {}) {
  return [...offers].sort((a, b) => {
    if (sort === 'score') {
      const scoreDiff = (b.score ?? 0) - (a.score ?? 0);
      if (scoreDiff !== 0) return scoreDiff;
    }

    const aPrice = a.price?.amount ?? Number.POSITIVE_INFINITY;
    const bPrice = b.price?.amount ?? Number.POSITIVE_INFINITY;
    if (aPrice !== bPrice) return aPrice - bPrice;
    return (b.score ?? 0) - (a.score ?? 0);
  });
}
