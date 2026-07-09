import { createHash } from 'node:crypto';

const DEFAULT_TTL_MS = 86400000;
const DEFAULT_MAX_ENTRIES = 10000;

// Short-lived cache of completed responses keyed by an idempotency fingerprint.
// In-memory Map only: idempotency is a transient safety net against duplicate
// client retries, so there is no file persistence to fail on. Following the
// house idiom (OrderStore/AccountStore) it takes an injected clock, evicts the
// oldest entry past maxEntries, and never throws during normal operation.
export class IdempotencyStore {
  constructor({ ttlMs = DEFAULT_TTL_MS, maxEntries = DEFAULT_MAX_ENTRIES, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.byKey = new Map();
  }

  // Deterministic, collision-resistant fingerprint of the four request facets.
  // The parts are length-prefixed before hashing so that no combination of
  // boundaries can collide (e.g. "a" + "bc" cannot alias "ab" + "c").
  keyFor(principal, method, path, idempotencyKey) {
    const parts = [principal, method, path, idempotencyKey];
    const joined = parts.map((part) => {
      const value = part == null ? '' : String(part);
      return `${value.length}:${value}`;
    }).join('|');
    return createHash('sha256').update(joined).digest('hex');
  }

  // Completed response for this key, or null when missing or expired. Expired
  // entries are removed on access so the Map does not retain dead responses.
  get(key) {
    const entry = this.byKey.get(key);
    if (!entry) return null;
    if (entry.createdAt + this.ttlMs <= this.now()) {
      this.byKey.delete(key);
      return null;
    }
    return { statusCode: entry.statusCode, body: entry.body };
  }

  // Record a completed response, overwriting any prior entry for the key and
  // evicting the oldest entry by createdAt once the cache exceeds maxEntries.
  put(key, statusCode, body) {
    this.byKey.set(key, { statusCode, body, createdAt: this.now() });
    if (this.byKey.size > this.maxEntries) this.evictOldest();
  }

  evictOldest() {
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const [key, entry] of this.byKey) {
      if (entry.createdAt < oldestAt) {
        oldestAt = entry.createdAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== null) this.byKey.delete(oldestKey);
  }
}
