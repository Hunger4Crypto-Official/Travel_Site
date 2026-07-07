import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const DEFAULT_MAX_ENTRIES = 100000;

// Owner-scoped append-only ledger of loyalty point transactions. In-memory Map
// keyed by id, best-effort JSONL persistence identical in spirit to OrderStore:
// a failed write records lastPersistError but never breaks the in-memory
// mutation, and an unreadable file boots an empty ledger instead of crashing. A
// Postgres-backed implementation can replace this class behind the same method
// surface.
export class LoyaltyLedger {
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
        const txn = JSON.parse(line);
        if (txn && typeof txn.id === 'string') loaded.push(txn);
      } catch {
        // A corrupt line loses one transaction, never the whole ledger.
      }
    }
    loaded.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    const kept = loaded.length > this.maxEntries ? loaded.slice(-this.maxEntries) : loaded;
    for (const txn of kept) this.byId.set(txn.id, txn);
  }

  record({ owner, type, points, reason = null, orderId = null, balanceAfter }) {
    const txn = { id: this.idFactory(), owner, type, points, reason, orderId, balanceAfter, createdAt: this.now() };
    this.byId.set(txn.id, txn);
    if (this.byId.size > this.maxEntries) this.evictOldest();
    this.persist();
    return txn;
  }

  list(owner) {
    return [...this.byId.values()]
      .filter((txn) => txn.owner === owner)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  evictOldest() {
    let oldestId = null;
    let oldestAt = Infinity;
    for (const txn of this.byId.values()) {
      if (txn.createdAt < oldestAt) {
        oldestAt = txn.createdAt;
        oldestId = txn.id;
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
      const body = [...this.byId.values()].map((txn) => JSON.stringify(txn)).join('\n');
      writeFileSync(this.filePath, body ? `${body}\n` : '');
      this.lastPersistError = null;
    } catch (err) {
      this.lastPersistError = err.message;
    }
  }
}
