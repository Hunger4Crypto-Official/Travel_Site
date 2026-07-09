import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const DEFAULT_MAX_ENTRIES = 5000;
const SECRET_KEY = /pass|secret|token|authorization|key|cookie/i;
const REDACTED = '[redacted]';

// Append-only audit trail of actor actions. In-memory Map keyed by event id with
// best-effort JSONL persistence following the OrderStore idiom: a failed write
// records lastPersistError but never breaks the in-memory append, and an
// unreadable or partially corrupt file boots what it can instead of crashing.
// Secret-like meta values are redacted before an event is ever stored.
export class AuditLog {
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
        const event = JSON.parse(line);
        if (event && typeof event.id === 'string') loaded.push(event);
      } catch {
        // A corrupt line loses one event, never the whole log.
      }
    }
    loaded.sort((a, b) => (a.at || 0) - (b.at || 0));
    const kept = loaded.length > this.maxEntries ? loaded.slice(-this.maxEntries) : loaded;
    for (const event of kept) this.byId.set(event.id, event);
  }

  record({ actor, action, target = null, outcome = 'ok', meta = {} } = {}) {
    const event = {
      id: this.idFactory(),
      at: this.now(),
      actor,
      action,
      target,
      outcome,
      meta: redact(meta)
    };
    this.byId.set(event.id, event);
    if (this.byId.size > this.maxEntries) this.evictOldest();
    this.persist();
    return event;
  }

  list({ limit = 100 } = {}) {
    return [...this.byId.values()]
      .sort((a, b) => (b.at || 0) - (a.at || 0))
      .slice(0, limit);
  }

  evictOldest() {
    let oldestId = null;
    let oldestAt = Infinity;
    for (const event of this.byId.values()) {
      if (event.at < oldestAt) {
        oldestAt = event.at;
        oldestId = event.id;
      }
    }
    this.byId.delete(oldestId);
  }

  persist() {
    if (!this.filePath) return;
    try {
      const body = [...this.byId.values()].map((event) => JSON.stringify(event)).join('\n');
      writeFileSync(this.filePath, body ? `${body}\n` : '');
      this.lastPersistError = null;
    } catch (err) {
      this.lastPersistError = err.message;
    }
  }
}

// Replace any secret-like value with a placeholder, descending one level into
// nested plain objects. Non-object meta is coerced to an empty object.
function redact(meta) {
  if (!meta || typeof meta !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(meta)) {
    if (SECRET_KEY.test(key)) {
      out[key] = REDACTED;
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = {};
      for (const [innerKey, innerValue] of Object.entries(value)) {
        nested[innerKey] = SECRET_KEY.test(innerKey) ? REDACTED : innerValue;
      }
      out[key] = nested;
    } else {
      out[key] = value;
    }
  }
  return out;
}
