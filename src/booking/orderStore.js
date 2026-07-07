import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const DEFAULT_MAX_ENTRIES = 50000;

// Owner-scoped store of booking orders. In-memory Map keyed by id, best-effort
// JSONL persistence identical in spirit to AccountStore/AlertStore: a failed
// write records lastPersistError but never breaks the in-memory mutation, and
// an unreadable file boots an empty store instead of crashing. A Postgres-backed
// implementation can replace this class behind the same method surface.
export class OrderStore {
  constructor({ filePath = null, maxEntries = DEFAULT_MAX_ENTRIES, now = () => Date.now(), idFactory = randomUUID } = {}) {
    this.filePath = filePath;
    this.maxEntries = maxEntries;
    this.now = now;
    this.idFactory = idFactory;
    this.byId = new Map();
    this.lastPersistError = null;
    this.load();
  }

  load() {
    if (!this.filePath || !existsSync(this.filePath)) return;
    let raw;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch (err) {
      this.lastPersistError = err.message;
      return;
    }
    const loaded = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const order = JSON.parse(line);
        if (order && typeof order.id === 'string') loaded.push(order);
      } catch {
        // A corrupt line loses one order, never the whole store.
      }
    }
    loaded.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    const kept = loaded.length > this.maxEntries ? loaded.slice(-this.maxEntries) : loaded;
    for (const order of kept) this.byId.set(order.id, order);
  }

  create(order) {
    const timestamp = this.now();
    const record = { ...order, id: this.idFactory(), createdAt: timestamp, updatedAt: timestamp };
    this.byId.set(record.id, record);
    if (this.byId.size > this.maxEntries) this.evictOldest();
    this.persist();
    return record;
  }

  get(id) {
    return this.byId.get(id) || null;
  }

  list(owner) {
    return [...this.byId.values()]
      .filter((order) => order.owner === owner)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  update(id, patch = {}) {
    const order = this.byId.get(id);
    if (!order) return null;
    const { id: ignoredId, createdAt: ignoredCreatedAt, ...safe } = patch;
    void ignoredId;
    void ignoredCreatedAt;
    const updated = { ...order, ...safe, updatedAt: this.now() };
    this.byId.set(id, updated);
    this.persist();
    return updated;
  }

  evictOldest() {
    let oldestId = null;
    let oldestAt = Infinity;
    for (const order of this.byId.values()) {
      if (order.createdAt < oldestAt) {
        oldestAt = order.createdAt;
        oldestId = order.id;
      }
    }
    this.byId.delete(oldestId);
  }

  count() {
    return this.byId.size;
  }

  persist() {
    if (!this.filePath) return;
    try {
      const body = [...this.byId.values()].map((order) => JSON.stringify(order)).join('\n');
      writeFileSync(this.filePath, body ? `${body}\n` : '');
      this.lastPersistError = null;
    } catch (err) {
      this.lastPersistError = err.message;
    }
  }
}
