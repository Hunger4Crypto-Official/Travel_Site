import { fetchJson } from './httpClient.js';

const DEFAULT_BASE_URL = 'https://api.frankfurter.app';

// Currency conversion backed by the free, no-key Frankfurter API (ECB rates).
// Rates are cached with a TTL. Can be seeded with static rates for offline use
// and tests. Rates are expressed as units of currency X per 1 unit of `base`.
export class CurrencyConverter {
  constructor({
    base = 'USD',
    fetchImpl,
    timeoutMs,
    ttlMs = 3600000,
    rates = null,
    now
  } = {}) {
    this.base = base.toUpperCase();
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.timeoutMs = timeoutMs;
    this.ttlMs = ttlMs;
    this.baseUrl = DEFAULT_BASE_URL;
    this.now = now || (() => Date.now());
    this.rates = null;
    this.fetchedAt = 0;
    this.inflight = null;
    if (rates) this.seedRates(rates);
  }

  seedRates(rates) {
    this.rates = { ...rates, [this.base]: 1 };
    this.fetchedAt = this.now();
  }

  isFresh() {
    return this.rates !== null && (this.now() - this.fetchedAt) < this.ttlMs;
  }

  async ensureRates() {
    if (this.isFresh()) return this.rates;
    // Collapse concurrent refreshes into a single upstream request.
    if (this.inflight) return this.inflight;
    this.inflight = this.refreshRates().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  async refreshRates() {
    const payload = await fetchJson(`${this.baseUrl}/latest?base=${encodeURIComponent(this.base)}`, {
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
      headers: { accept: 'application/json' }
    });
    if (!payload?.rates || typeof payload.rates !== 'object') {
      throw new Error('Currency rates response was malformed');
    }
    this.rates = { ...payload.rates, [this.base]: 1 };
    this.fetchedAt = this.now();
    return this.rates;
  }

  // Synchronous conversion using whatever rates are currently loaded.
  // Returns null when a required rate is unavailable so callers can keep the
  // original amount instead of inventing a number.
  convert(amount, from, to) {
    const value = Number(amount);
    if (!Number.isFinite(value)) return null;
    const fromCur = String(from || this.base).toUpperCase();
    const toCur = String(to || this.base).toUpperCase();
    if (fromCur === toCur) return value;
    if (!this.rates) return null;
    const fromRate = this.rates[fromCur];
    const toRate = this.rates[toCur];
    if (!Number.isFinite(fromRate) || !Number.isFinite(toRate) || fromRate === 0) return null;
    return (value / fromRate) * toRate;
  }
}
