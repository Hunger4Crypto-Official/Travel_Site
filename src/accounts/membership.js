// Membership tier catalog for the travel club. Zero dependencies.
// Tiers are ordered cheapest first so the array index doubles as the rank.

export const TIERS = [
  {
    id: 'free',
    name: 'Explorer',
    priceMonthlyUsd: 0,
    memberRates: false,
    loyaltyMultiplier: 1,
    benefits: [
      'Compare all providers for the lowest all-in price',
      'Price alerts and saved searches',
      'Honest, no fake urgency pricing'
    ]
  },
  {
    id: 'silver',
    name: 'Voyager',
    priceMonthlyUsd: 9.99,
    memberRates: true,
    loyaltyMultiplier: 2,
    benefits: [
      'Everything in Explorer',
      'Member-only rates on hotels, flights, and cars',
      '2x loyalty points on every booking',
      'Priority support (faster response times)'
    ]
  },
  {
    id: 'gold',
    name: 'Globetrotter',
    priceMonthlyUsd: 24.99,
    memberRates: true,
    loyaltyMultiplier: 3,
    benefits: [
      'Everything in Voyager',
      '3x loyalty points on every booking',
      'Waived booking service fees',
      'Dedicated concierge (planning and rebooking help)'
    ]
  }
];

// Return the tier object for an id, or null when the id is unknown.
export function getTier(id) {
  return TIERS.find((tier) => tier.id === id) ?? null;
}

// Rank a tier by its position in TIERS (free=0, silver=1, gold=2).
// Unknown or free ids rank 0; higher numbers are better tiers.
export function tierRank(id) {
  const index = TIERS.findIndex((tier) => tier.id === id);
  return index === -1 ? 0 : index;
}

// True only when the tier exists and grants member-only rates.
export function hasMemberRates(tierId) {
  const tier = getTier(tierId);
  return tier !== null && tier.memberRates === true;
}

// The tier's benefits list, or an empty array for an unknown id.
export function benefitsFor(tierId) {
  const tier = getTier(tierId);
  return tier === null ? [] : tier.benefits;
}

// The tier every new account starts on.
export function defaultTierId() {
  return 'free';
}
