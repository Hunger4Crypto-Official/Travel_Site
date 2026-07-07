import { hashPassword, verifyPassword } from './passwords.js';
import { getTier, hasMemberRates, benefitsFor, defaultTierId } from './membership.js';

// Deliberately permissive: a lightweight shape check, not RFC 5322. Delivery is
// the real validator once email verification lands in a later phase.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Orchestrates the account lifecycle over an AccountStore and a session manager.
// Public results never carry the password hash: publicUser() is the only shape
// that leaves this service toward a response.
export class AccountService {
  constructor({ store, sessions }) {
    this.store = store;
    this.sessions = sessions;
  }

  signup(input = {}) {
    const email = normalizeEmail(input.email);
    const passwordHash = hashPassword(input.password);
    const user = this.store.create({ email, passwordHash, tier: defaultTierId(), role: 'member' });
    return { user: publicUser(user), token: this.sessions.issue(user.id) };
  }

  login(input = {}) {
    const email = normalizeEmail(input.email);
    const user = this.store.findByEmail(email);
    if (!user || !verifyPassword(input.password ?? '', user.passwordHash)) {
      throw unauthorized('Invalid email or password');
    }
    return { user: publicUser(user), token: this.sessions.issue(user.id) };
  }

  // Resolve a raw session token to the full internal user record (carries the
  // password hash), for the router to attach identity. Returns null when the
  // token is missing, invalid, expired, or the user no longer exists.
  identify(token) {
    const session = this.sessions.verify(token);
    if (!session) return null;
    const user = this.store.get(session.userId);
    if (!user) return null;
    return { user, session };
  }

  me(user) {
    return publicUser(user);
  }

  setTier(userId, tierId) {
    if (!getTier(tierId)) throw badRequest('Unknown membership tier');
    const updated = this.store.update(userId, { tier: tierId });
    return updated ? publicUser(updated) : null;
  }
}

function normalizeEmail(email) {
  if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
    throw badRequest('A valid email address is required');
  }
  return email.trim().toLowerCase();
}

// The only user shape that leaves the service toward a response. Never includes
// passwordHash. Falls back to the default tier if a stored tier id is unknown.
export function publicUser(user) {
  const tier = getTier(user.tier) || getTier(defaultTierId());
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    tier: tier.id,
    tierName: tier.name,
    memberRates: hasMemberRates(tier.id),
    benefits: benefitsFor(tier.id),
    loyaltyPoints: user.loyaltyPoints ?? 0,
    subscriptionStatus: user.subscriptionStatus ?? null,
    subscriptionTier: user.subscriptionTier ?? null,
    createdAt: user.createdAt
  };
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function unauthorized(message) {
  const err = new Error(message);
  err.statusCode = 401;
  return err;
}
