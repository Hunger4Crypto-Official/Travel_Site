import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const DEFAULT_MAX_ENTRIES = 100000;

// Owner of user records. In-memory Map keyed by id, with a secondary email
// index that enforces the unique-email constraint and powers login lookups.
// JSONL persistence mirrors AlertStore: best-effort, records lastPersistError,
// and never throws on a failed write. A Postgres-backed implementation can
// replace this class behind the same method surface for production scale.
export class AccountStore {
  constructor({ filePath = null, maxEntries = DEFAULT_MAX_ENTRIES, now = () => Date.now(), idFactory = randomUUID } = {}) {
    this.filePath = filePath;
    this.maxEntries = maxEntries;
    this.now = now;
    this.idFactory = idFactory;
    this.byId = new Map();
    this.byEmail = new Map();
    this.lastPersistError = null;
    this.load();
  }

  load() {
    if (!this.filePath || !existsSync(this.filePath)) return;
    let raw;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch (err) {
      // An unreadable path (wrong permissions, a directory) must not crash
      // startup; boot with an empty store and record why.
      this.lastPersistError = err.message;
      return;
    }
    const lines = raw.split('\n');
    const loaded = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const user = JSON.parse(line);
        if (user && typeof user.id === 'string' && typeof user.email === 'string') loaded.push(user);
      } catch {
        // A corrupt line loses one user, never the whole store.
      }
    }
    loaded.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    const kept = loaded.length > this.maxEntries ? loaded.slice(-this.maxEntries) : loaded;
    for (const user of kept) {
      this.byId.set(user.id, user);
      this.byEmail.set(user.email, user.id);
    }
  }

  create({ email, passwordHash, tier = 'free', role = 'member' }) {
    if (this.byEmail.has(email)) {
      throw conflict('An account with that email already exists');
    }
    const timestamp = this.now();
    const user = {
      id: this.idFactory(),
      email,
      passwordHash,
      tier,
      role,
      loyaltyPoints: 0,
      tokenGeneration: 0,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.byId.set(user.id, user);
    this.byEmail.set(email, user.id);
    this.persist();
    return user;
  }

  get(id) {
    return this.byId.get(id) || null;
  }

  findByEmail(email) {
    const id = this.byEmail.get(email);
    return id ? this.byId.get(id) || null : null;
  }

  update(id, patch = {}) {
    const user = this.byId.get(id);
    if (!user) return null;
    // email and id are index keys; keep them immutable to avoid index drift.
    const { email, id: ignoredId, ...safe } = patch;
    void email;
    void ignoredId;
    const updated = { ...user, ...safe, updatedAt: this.now() };
    this.byId.set(id, updated);
    this.persist();
    return updated;
  }

  count() {
    return this.byId.size;
  }

  persist() {
    if (!this.filePath) return;
    try {
      const body = [...this.byId.values()].map((user) => JSON.stringify(user)).join('\n');
      writeFileSync(this.filePath, body ? `${body}\n` : '');
      this.lastPersistError = null;
    } catch (err) {
      // Persistence is best-effort; a full disk must never break a mutation.
      this.lastPersistError = err.message;
    }
  }
}

function conflict(message) {
  const err = new Error(message);
  err.statusCode = 409;
  return err;
}
