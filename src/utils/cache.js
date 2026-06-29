export class MemoryCache {
  constructor({ ttlMs = 300000, maxEntries = 1000 } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.items = new Map();
  }

  get(key) {
    const item = this.items.get(key);
    if (!item) return undefined;
    if (Date.now() > item.expiresAt) {
      this.items.delete(key);
      return undefined;
    }
    this.items.delete(key);
    this.items.set(key, item);
    return item.value;
  }

  set(key, value, ttlMs = this.ttlMs) {
    if (this.maxEntries === 0) return value;
    if (this.items.size >= this.maxEntries && !this.items.has(key)) {
      const oldestKey = this.items.keys().next().value;
      this.items.delete(oldestKey);
    }
    this.items.set(key, { value, expiresAt: Date.now() + ttlMs });
    return value;
  }

  delete(key) {
    return this.items.delete(key);
  }

  clear() {
    this.items.clear();
  }
}
