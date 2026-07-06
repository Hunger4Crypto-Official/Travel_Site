import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const DEFAULT_MAX_ENTRIES = 5000;
const DEFAULT_WINDOW_MS = 30 * 86400000; // 30 days

// Append-only store of the cheapest real price seen per search, powering the
// "vs. recent average" context on search responses and /v1/prices/history.
// In-memory by default; pass filePath for zero-dependency JSONL persistence.
// Demo prices are never recorded (the engine filters them before calling us).
export class PriceHistoryStore {
  constructor({ filePath = null, maxEntries = DEFAULT_MAX_ENTRIES, now = () => Date.now() } = {}) {
    this.filePath = filePath;
    this.maxEntries = maxEntries;
    this.now = now;
    this.entries = [];
    this.lastPersistError = null;
    this.load();
  }

  load() {
    if (!this.filePath || !existsSync(this.filePath)) return;
    const lines = readFileSync(this.filePath, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (Number.isFinite(entry.t) && Number.isFinite(entry.total)) this.entries.push(entry);
      } catch {
        // A corrupt line loses one sample, never the whole store.
      }
    }
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }
  }

  record({ type, key, currency, total, provider }) {
    if (!Number.isFinite(total)) return null;
    const entry = { t: this.now(), type, key, currency, total, provider };
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) this.entries.shift();
    if (this.filePath) {
      try {
        appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`);
        this.lastPersistError = null;
      } catch (err) {
        // Persistence is best-effort; a full disk must never break search.
        this.lastPersistError = err.message;
      }
    }
    return entry;
  }

  // Aggregates entries for one search key in one currency inside the window.
  stats({ type, key, currency, windowMs = DEFAULT_WINDOW_MS }) {
    const cutoff = this.now() - windowMs;
    const rows = this.entries.filter((e) => e.type === type && e.key === key && e.currency === currency && e.t >= cutoff);
    if (rows.length === 0) return null;
    const totals = rows.map((r) => r.total);
    return {
      samples: rows.length,
      average: round2(totals.reduce((a, b) => a + b, 0) / rows.length),
      lowest: Math.min(...totals),
      latest: totals[totals.length - 1]
    };
  }

  // The most recent entry for a key regardless of currency, so callers can
  // pick the currency to aggregate in.
  latestFor(type, key) {
    for (let i = this.entries.length - 1; i >= 0; i -= 1) {
      const e = this.entries[i];
      if (e.type === type && e.key === key) return e;
    }
    return null;
  }

  // Recent series for the history endpoint (oldest -> newest, capped).
  series({ type, key, currency, windowMs = DEFAULT_WINDOW_MS, limit = 50 }) {
    const cutoff = this.now() - windowMs;
    return this.entries
      .filter((e) => e.type === type && e.key === key && e.currency === currency && e.t >= cutoff)
      .slice(-limit)
      .map((e) => ({ at: new Date(e.t).toISOString(), total: e.total, provider: e.provider }));
  }
}

// Builds the stable history key for a search: flights aggregate per route,
// hotels per city + stay length (a 2-night and a 5-night total are not
// comparable), cars per city. Other verticals have no meaningful price.
export function priceHistoryKey(type, query = {}) {
  if (type === 'flights') {
    const from = String(query.from || '').trim().toUpperCase();
    const to = String(query.to || '').trim().toUpperCase();
    return from && to ? `${from}-${to}` : null;
  }
  if (type === 'hotels') {
    const city = String(query.city || '').trim().toLowerCase();
    if (!city) return null;
    return `${city}|${stayNights(query.checkin, query.checkout)}`;
  }
  if (type === 'cars') {
    const city = String(query.city || '').trim().toLowerCase();
    return city || null;
  }
  return null;
}

function stayNights(checkin, checkout) {
  const start = Date.parse(`${checkin}T00:00:00Z`);
  const end = Date.parse(`${checkout}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 'any';
  return `${Math.round((end - start) / 86400000)}n`;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}
