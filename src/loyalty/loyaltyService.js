import { getTier } from '../accounts/membership.js';

const POINTS_PER_USD = 100; // 100 points == 1 USD of account credit on redemption.

// Loyalty program over a LoyaltyLedger and the shared AccountStore. Points are
// earned on confirmed bookings (base trip total times the tier multiplier) and
// redeemed for account credit. The member's running balance lives on the user
// record; the ledger keeps the per-transaction history.
export class LoyaltyService {
  constructor({ ledger, accountStore } = {}) {
    this.ledger = ledger;
    this.accountStore = accountStore;
  }

  // Award points for a confirmed order. `owner` is the order's principal; only
  // signed-in members (user:<id>) earn. Returns null for anonymous/API callers,
  // a vanished user, or a non-positive award.
  earnForBooking(owner, order) {
    const userId = userIdOf(owner);
    if (!userId) return null;
    const user = this.accountStore.get(userId);
    if (!user) return null;
    const multiplier = multiplierFor(user.tier);
    const base = Math.round(numberOr(order?.price?.total ?? order?.total, 0));
    const points = base * multiplier;
    if (points <= 0) return null;
    const balanceAfter = (user.loyaltyPoints ?? 0) + points;
    this.accountStore.update(userId, { loyaltyPoints: balanceAfter });
    const transaction = this.ledger.record({ owner: userId, type: 'earn', points, reason: `Booking ${order.id}`, orderId: order.id, balanceAfter });
    return { points, balance: balanceAfter, transaction };
  }

  redeem(user, points) {
    if (!Number.isInteger(points) || points <= 0) {
      throw badRequest('Redeem a positive whole number of points');
    }
    const balance = user.loyaltyPoints ?? 0;
    if (points > balance) {
      throw badRequest('You do not have enough points to redeem that amount');
    }
    const balanceAfter = balance - points;
    this.accountStore.update(user.id, { loyaltyPoints: balanceAfter });
    const transaction = this.ledger.record({ owner: user.id, type: 'redeem', points, reason: 'Redeemed for account credit', balanceAfter });
    return { balance: balanceAfter, creditUsd: round2(points / POINTS_PER_USD), transaction };
  }

  summary(user) {
    return {
      balance: user.loyaltyPoints ?? 0,
      multiplier: multiplierFor(user.tier),
      pointsPerUsd: POINTS_PER_USD,
      transactions: this.ledger.list(user.id)
    };
  }
}

function userIdOf(owner) {
  return typeof owner === 'string' && owner.startsWith('user:') ? owner.slice(5) : null;
}

function multiplierFor(tierId) {
  const tier = getTier(tierId);
  return tier ? tier.loyaltyMultiplier : 1;
}

function numberOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}
