import { hashPassword, verifyPassword } from './passwords.js';
import { getTier, hasMemberRates, benefitsFor, defaultTierId } from './membership.js';

// Deliberately permissive: a lightweight shape check, not RFC 5322. Delivery is
// the real validator once email verification lands in a later phase.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// A fixed decoy hash so login runs the same scrypt work whether or not the
// email exists, closing the timing oracle that would otherwise enumerate
// accounts. Computed once at module load (top-level await).
const DECOY_HASH = await hashPassword('decoy-account-benchmark-value');

// Orchestrates the account lifecycle over an AccountStore and a session manager.
// Public results never carry the password hash: publicUser() is the only shape
// that leaves this service toward a response.
export class AccountService {
  constructor({ store, sessions }) {
    this.store = store;
    this.sessions = sessions;
  }

  async signup(input = {}) {
    const email = normalizeEmail(input.email);
    const passwordHash = await hashPassword(input.password);
    const user = this.store.create({ email, passwordHash, tier: defaultTierId(), role: 'member' });
    return { user: publicUser(user), token: this.sessions.issue(user.id, user.tokenGeneration) };
  }

  async login(input = {}) {
    const email = normalizeEmail(input.email);
    const user = this.store.findByEmail(email);
    // Always verify against a real hash (the decoy when the user is absent) so
    // both branches do equal scrypt work and cannot be timed apart.
    const passwordOk = await verifyPassword(input.password ?? '', user ? user.passwordHash : DECOY_HASH);
    if (!user || !passwordOk) {
      throw unauthorized('Invalid email or password');
    }
    return { user: publicUser(user), token: this.sessions.issue(user.id, user.tokenGeneration) };
  }

  // Resolve a raw session token to the full internal user record (carries the
  // password hash), for the router to attach identity. Returns null when the
  // token is missing, invalid, expired, the user no longer exists, or the
  // token's generation is stale (logged out / password changed).
  identify(token) {
    const session = this.sessions.verify(token);
    if (!session) return null;
    const user = this.store.get(session.userId);
    if (!user) return null;
    if ((user.tokenGeneration ?? 0) !== session.gen) return null;
    return { user, session };
  }

  // Invalidate every existing session for a user (logout / password change) by
  // bumping their token generation.
  logout(user) {
    return this.store.update(user.id, { tokenGeneration: (user.tokenGeneration ?? 0) + 1 });
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
