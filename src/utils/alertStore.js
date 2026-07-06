import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const DEFAULT_MAX_ENTRIES = 1000;
const VALID_TYPES = new Set(['flights', 'hotels', 'cars']);

// Persistent, owner-scoped store of "watches". A watch is a saved search;
// when it carries a finite threshold it is a price alert the background sweep
// can trigger. In-memory by default; pass filePath for zero-dependency JSONL
// persistence. Persistence is best-effort: a failing write records
// this.lastPersistError but never breaks the in-memory mutation.
export class AlertStore {
  constructor({ filePath = null, maxEntries = DEFAULT_MAX_ENTRIES, now = () => Date.now(), idFactory = randomUUID } = {}) {
    this.filePath = filePath;
    this.maxEntries = maxEntries;
    this.now = now;
    this.idFactory = idFactory;
    this.watches = new Map();
    this.lastPersistError = null;
    this.load();
  }

  load() {
    if (!this.filePath || !existsSync(this.filePath)) return;
    const lines = readFileSync(this.filePath, 'utf8').split('\n');
    const loaded = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const watch = JSON.parse(line);
        if (watch && typeof watch.id === 'string') loaded.push(watch);
      } catch {
        // A corrupt line loses one watch, never the whole store.
      }
    }
    loaded.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    const kept = loaded.length > this.maxEntries ? loaded.slice(-this.maxEntries) : loaded;
    for (const watch of kept) this.watches.set(watch.id, watch);
  }

  create(input = {}) {
    const type = input.type;
    if (!VALID_TYPES.has(type)) {
      throw badRequest(`type must be one of flights, hotels, cars (got ${JSON.stringify(type)})`);
    }
    let threshold = null;
    if (input.threshold !== undefined && input.threshold !== null) {
      if (!Number.isFinite(input.threshold) || input.threshold < 0) {
        throw badRequest('threshold must be a finite non-negative number');
      }
      threshold = input.threshold;
    }
    const watch = {
      id: this.idFactory(),
      owner: typeof input.owner === 'string' ? input.owner : 'anonymous',
      type,
      query: input.query && typeof input.query === 'object' ? input.query : {},
      key: typeof input.key === 'string' ? input.key : null,
      threshold,
      currency: typeof input.currency === 'string' ? input.currency : null,
      notifyUrl: typeof input.notifyUrl === 'string' ? input.notifyUrl : null,
      createdAt: this.now(),
      active: true,
      lastPrice: null,
      triggered: false,
      lastTriggeredAt: null,
      lastCheckedAt: null
    };
    this.watches.set(watch.id, watch);
    if (this.watches.size > this.maxEntries) this.evictOldest();
    this.persist();
    return watch;
  }

  evictOldest() {
    let oldestId = null;
    let oldestAt = Infinity;
    for (const watch of this.watches.values()) {
      if (watch.createdAt < oldestAt) {
        oldestAt = watch.createdAt;
        oldestId = watch.id;
      }
    }
    this.watches.delete(oldestId);
  }

  get(id) {
    return this.watches.get(id) || null;
  }

  list(owner) {
    return [...this.watches.values()]
      .filter((watch) => watch.owner === owner)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  remove(id, owner) {
    const watch = this.watches.get(id);
    if (!watch || watch.owner !== owner) return false;
    this.watches.delete(id);
    this.persist();
    return true;
  }

  update(id, patch = {}) {
    const watch = this.watches.get(id);
    if (!watch) return null;
    const updated = { ...watch, ...patch };
    this.watches.set(id, updated);
    this.persist();
    return updated;
  }

  activeWatches() {
    return [...this.watches.values()].filter((watch) => watch.active !== false);
  }

  persist() {
    if (!this.filePath) return;
    try {
      const body = [...this.watches.values()].map((watch) => JSON.stringify(watch)).join('\n');
      writeFileSync(this.filePath, body ? `${body}\n` : '');
      this.lastPersistError = null;
    } catch (err) {
      // Persistence is best-effort; a full disk must never break a mutation.
      this.lastPersistError = err.message;
    }
  }
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}
